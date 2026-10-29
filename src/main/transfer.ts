// 导出/导入：单流程 zip = workflow.json + files/<sha256>_<name>
// 与备份 zip 明确区分：备份含 helpwork.db，导出包只含 JSON + 实体文件
// v2：导出含并行分支结构；导入兼容 v1（无分支字段 → 单主干）与 v2 包
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lp, norm, sanitizeFileName, uuid } from './util';
import { log } from './logger';
import { entityAbsPath, tmpDir, storeFile, cleanTmp } from './files';
import * as svc from './services';
import * as branchesSvc from './branches';
import type { ExportPayload, ExportNodeInfo, ExportBranchInfo } from './transfer-types';

function parseExtra(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

function unknownFields(value: Record<string, unknown>, known: readonly string[]): string | null {
  const set = new Set(known);
  const extra = Object.fromEntries(Object.entries(value).filter(([k]) => !set.has(k)));
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

/** 导出单流程为 zip，返回绝对路径（保存在 <数据目录>\exports\） */
export function exportWorkflowZip(dataDir: string, workflowId: string): string {
  const w = svc.getWorkflow(workflowId);
  if (!w) throw new Error('流程不存在或已删除');
  const nodes = svc.listNodes(workflowId);
  const brs = branchesSvc.listBranches(workflowId);
  const hasBranches = brs.length > 0;
  const workflowBag = parseExtra(w.extra_json);
  const storedWorkflowExtra = workflowBag.__hw_workflow_extra && typeof workflowBag.__hw_workflow_extra === 'object'
    ? workflowBag.__hw_workflow_extra as Record<string, unknown>
    : Object.fromEntries(Object.entries(workflowBag).filter(([k]) => !k.startsWith('__hw_')));
  const storedPayloadExtra = workflowBag.__hw_payload_extra && typeof workflowBag.__hw_payload_extra === 'object'
    ? workflowBag.__hw_payload_extra as Record<string, unknown>
    : {};
  const payload: ExportPayload = {
    ...storedPayloadExtra,
    format: 'helpwork-workflow',
    version: hasBranches ? 2 : 1,
    exported_at: new Date().toISOString(),
    workflow: { ...storedWorkflowExtra, id: w.id, name: w.name, description: w.description },
    nodes: nodes.map((n) => ({
      ...parseExtra(n.extra_json),
      id: n.id,
      title: n.title,
      note: n.note,
      sort_order: n.sort_order,
      ...(hasBranches ? { parent_id: n.parent_id ?? null, branch_id: n.branch_id ?? null } : {}),
      attachments: svc.listAttachments(n.id).map((a) => ({
        ...parseExtra(a.extra_json),
        id: a.id,
        sha256: a.sha256,
        original_name: a.original_name,
        stored_path: a.stored_path,
        size: a.size,
        ext: a.ext,
        created_at: a.created_at
      }))
    })),
    branches: hasBranches
      ? brs.map((b) => ({
          ...parseExtra(b.extra_json),
          id: b.id,
          fork_node_id: b.fork_node_id,
          name: b.name,
          status: b.status,
          completed_at: b.completed_at,
          sort_order: b.sort_order
        }))
      : undefined
  };

  const zip = new AdmZip();
  zip.addFile('workflow.json', Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));

  // 收集实体文件（按 sha 去重）
  const seen = new Set<string>();
  for (const n of payload.nodes) {
    for (const a of n.attachments) {
      if (seen.has(a.sha256)) continue;
      seen.add(a.sha256);
      const abs = entityAbsPath(dataDir, a.stored_path);
      if (!fs.existsSync(lp(abs))) {
        log.warn(`导出时实体缺失，跳过：${a.stored_path}`);
        continue;
      }
      const entry = norm(a.stored_path).replace(/\\/g, '/');
      zip.addFile(`files/${entry}`, fs.readFileSync(lp(abs)));
    }
  }

  const outDir = path.join(dataDir, 'exports');
  fs.mkdirSync(lp(outDir), { recursive: true });
  const ts = new Date();
  const p2 = (x: number) => String(x).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}_${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}`;
  const out = path.join(outDir, `${sanitizeFileName(w.name)}_${stamp}.zip`);
  zip.writeZip(lp(out));
  log.info(`流程已导出：${w.name} → ${out}（${hasBranches ? 'v2 含分支' : 'v1 线性'}）`);
  return out;
}

/** 校验并解析导出 zip（不落库）。失败抛中文错误。 */
export function parseImportZip(zipPath: string): { payload: ExportPayload; zip: AdmZip } {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    throw new Error('无法读取压缩包，可能已损坏');
  }
  const entry = zip.getEntry('workflow.json');
  if (!entry) throw new Error('这不是 HelpWork 导出的流程包（缺少 workflow.json）');
  let payload: ExportPayload;
  try {
    payload = JSON.parse(zip.readAsText(entry)) as ExportPayload;
  } catch {
    throw new Error('流程数据文件损坏（workflow.json 无法解析）');
  }
  if (payload.format !== 'helpwork-workflow' || !Array.isArray(payload.nodes) || !payload.workflow?.name) {
    throw new Error('这不是 HelpWork 导出的流程包（格式不匹配）');
  }
  // 版本归一化：未知/缺失版本按 1 处理（旧包透传兼容）
  const ver = payload.version ?? 1;
  if (ver !== 1 && ver !== 2) {
    log.warn(`导入包版本 ${ver} 未识别，按 v1 处理（未知分支字段忽略）`);
    payload.version = 1;
  }
  return { payload, zip };
}

/**
 * 导入流程 zip：新建流程（保留节点顺序、备注与 v2 分支结构），复制实体文件，同哈希复用已有实体。
 * v1 包 → 单主干流程；v2 包 → 还原分支、完成状态与嵌套层级。
 * 失败时软删刚建的流程并清理中转文件。
 */
export async function importWorkflowZip(
  dataDir: string,
  zipPath: string,
  onProgress?: (msg: string, percent: number) => void
): Promise<{ workflow_id: string; workflow_name: string }> {
  const { payload, zip } = parseImportZip(zipPath);
  onProgress?.('正在解析流程数据…', 5);

  let createdWorkflowId = '';
  try {
    const w = svc.createWorkflow(payload.workflow.name, payload.workflow.description ?? undefined);
    createdWorkflowId = w.id;
    const workflowExtra = parseExtra(unknownFields(payload.workflow as Record<string, unknown>, ['id', 'name', 'description']));
    const payloadExtra = parseExtra(unknownFields(payload as Record<string, unknown>, ['format', 'version', 'exported_at', 'workflow', 'nodes', 'branches']));
    const workflowBag = Object.keys(workflowExtra).length || Object.keys(payloadExtra).length
      ? JSON.stringify({ __hw_workflow_extra: workflowExtra, __hw_payload_extra: payloadExtra })
      : null;
    svc.updateWorkflowExtraJson(w.id, workflowBag);

    // id 映射：包内节点 id → 新库节点 id（分支 fork_node_id 需要重映射）
    const idMap = new Map<string, string>();
    const totalNodes = payload.nodes.length;

    // 第一遍：建节点（保持导出顺序；sort_order 原样透传以保证层级排序稳定）
    const created: { src: ExportNodeInfo; node: ReturnType<typeof svc.createNode> }[] = [];
    for (let i = 0; i < totalNodes; i++) {
      const src = payload.nodes[i];
      onProgress?.(`正在导入节点 ${i + 1}/${totalNodes}…`, 10 + Math.floor(((i + 1) / totalNodes) * 60));
      const n = svc.createNodeWithOrder(
        w.id,
        src.title,
        src.note ?? undefined,
        src.sort_order ?? i,
        { parentId: null, branchId: null }
      );
      idMap.set(src.id, n.id);
      svc.updateNodeExtraJson(n.id, unknownFields(src as Record<string, unknown>, ['id', 'title', 'note', 'sort_order', 'parent_id', 'branch_id', 'attachments']));
      created.push({ src, node: n });
    }

    // v2：还原分支（先建分支行，fork_node_id 用映射后的新 id）
    if (payload.version === 2 && Array.isArray(payload.branches) && payload.branches.length > 0) {
      const exportedBranches = payload.branches;
      const sourceNodeIds = new Set(payload.nodes.map((n) => n.id));
      const sourceBranchIds = new Set(exportedBranches.map((b) => b.id));
      for (const b of exportedBranches) {
        if (!sourceNodeIds.has(b.fork_node_id)) throw new Error(`流程包损坏：分支「${b.name}」的分叉点不存在`);
      }
      const branchBySourceId = new Map(exportedBranches.map((b) => [b.id, b]));
      for (const n of payload.nodes) {
        if (n.branch_id && !sourceBranchIds.has(n.branch_id)) throw new Error(`流程包损坏：节点「${n.title}」所属分支不存在`);
        if (n.parent_id && !sourceNodeIds.has(n.parent_id)) throw new Error(`流程包损坏：节点「${n.title}」的父节点不存在`);
        if (n.branch_id) {
          const b = branchBySourceId.get(n.branch_id);
          if (!b || n.parent_id !== b.fork_node_id) throw new Error(`流程包损坏：节点「${n.title}」的分叉挂点与所属分支不匹配`);
        } else if (n.parent_id) {
          throw new Error(`流程包损坏：主线节点「${n.title}」不能有 parent_id`);
        }
      }
      const branchIdMap = new Map<string, string>();
      for (const b of exportedBranches) branchIdMap.set(b.id, uuid());
      for (const b of exportedBranches) {
        const newFork = idMap.get(b.fork_node_id)!;
        branchesSvc.importBranchRow({
          id: branchIdMap.get(b.id)!,
          workflow_id: w.id,
          fork_node_id: newFork,
          name: b.name,
          status: b.status === 'done' ? 'done' : 'active',
          completed_at: b.completed_at ?? null,
          sort_order: b.sort_order ?? 0,
          extra_json: unknownFields(b as Record<string, unknown>, ['id', 'fork_node_id', 'name', 'status', 'completed_at', 'sort_order'])
        });
      }
      // 第二遍：修正节点的 parent_id / branch_id（v2 字段）
      for (const { src } of created) {
        const pid = src.parent_id ? idMap.get(src.parent_id) : null;
        const bid = src.branch_id ? branchIdMap.get(src.branch_id) ?? null : null;
        // 防孤儿：parent 映射不到（源数据损坏）→ 回落为主线
        if (src.parent_id && !pid) {
          log.warn(`导入节点「${src.title}」的父节点缺失，已回落为主线`);
        }
        svc.updateNodeRelations(svc.getNode(idMap.get(src.id)!)?.id ?? '', { parent_id: pid ?? null, branch_id: bid });
      }
    }

    // 第三遍：附件
    for (let i = 0; i < created.length; i++) {
      const { src, node } = created[i];
      for (const a of src.attachments) {
        const entryPath = `files/${norm(a.stored_path).replace(/\\/g, '/')}`;
        const entry = zip.getEntry(entryPath);
        if (!entry) {
          log.warn(`导入时实体缺失，跳过：${entryPath}`);
          continue;
        }
        // 解到 tmp 再按哈希规则落位（storeFile 内部含去重复用）
        const tmp = path.join(tmpDir(dataDir), `${a.sha256}_${sanitizeFileName(a.original_name)}`);
        fs.mkdirSync(lp(path.dirname(tmp)), { recursive: true });
        fs.writeFileSync(lp(tmp), zip.readFile(entry)!);
        const stored = await storeFile(dataDir, tmp, a.original_name);
        svc.addAttachmentRow({
          id: uuid(), // 新 id，避免与库中已有 id 冲突
          node_id: node.id,
          sha256: stored.sha256,
          original_name: a.original_name,
          stored_path: stored.stored_path,
          created_at: a.created_at || new Date().toISOString(),
          size: stored.size,
          ext: a.ext || path.extname(a.original_name).slice(1).toLowerCase() || null,
          extra_json: unknownFields(a as Record<string, unknown>, ['id', 'sha256', 'original_name', 'stored_path', 'size', 'ext', 'created_at'])
        });
      }
    }

    onProgress?.('导入完成', 100);
    log.info(`流程已导入：${payload.workflow.name}（${payload.nodes.length} 节点，v${payload.version}）`);
    return { workflow_id: w.id, workflow_name: w.name };
  } catch (e) {
    if (createdWorkflowId) {
      try {
        svc.deleteWorkflow(createdWorkflowId);
      } catch {
        /* 忽略回滚失败 */
      }
    }
    throw e;
  } finally {
    await cleanTmp(dataDir);
  }
}

/** 导出包中分支信息类型（供 branches.importBranchRow 使用） */
export type { ExportBranchInfo };

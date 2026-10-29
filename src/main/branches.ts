// 并行分支服务（v2 核心）：
// - 在分叉点下创建 N 条并行分支（N≥2），每条分支自带根节点
// - 分支内追加步骤、分支隔离
// - 显式标记/取消完成
// - 全完成门控：所有分支完成前，分叉点之后的主线不得追加新步骤
// - 嵌套再分叉（分支内节点同样可作为分叉点，深度不设硬上限）
// - 环检测与孤儿防护
import { getDb, withTx } from './db';
import { uuid, nowISO } from './util';
import { log } from './logger';
import * as svc from './services';
import type { BranchItem, NodeItem } from '../shared/types';

export type { BranchItem };

// ---------- 基础查询 ----------

function rowToBranch(r: Record<string, unknown>): BranchItem {
  return {
    id: r.id as string,
    workflow_id: r.workflow_id as string,
    fork_node_id: r.fork_node_id as string,
    name: r.name as string,
    status: (r.status === 'done' ? 'done' : 'active') as BranchItem['status'],
    completed_at: (r.completed_at as string | null) ?? null,
    sort_order: (r.sort_order as number) ?? 0,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    deleted_at: (r.deleted_at as string | null) ?? null,
    extra_json: svc.preserveUnknownColumns(r, ['id', 'workflow_id', 'fork_node_id', 'name', 'status', 'completed_at', 'sort_order', 'created_at', 'updated_at', 'deleted_at', 'extra_json'])
  };
}

export function getBranch(id: string): BranchItem | undefined {
  const r = getDb().prepare('SELECT * FROM branch WHERE id = ? AND deleted_at IS NULL').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToBranch(r) : undefined;
}

export function listBranches(workflowId: string): BranchItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM branch WHERE workflow_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all(workflowId) as unknown as Record<string, unknown>[];
  return rows.map(rowToBranch);
}

/** 某分叉点下的全部分支（按 sort_order） */
export function branchesAt(forkNodeId: string): BranchItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM branch WHERE fork_node_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all(forkNodeId) as unknown as Record<string, unknown>[];
  return rows.map(rowToBranch);
}

/** 某分支的全部节点（按 sort_order） */
export function branchNodes(branchId: string): NodeItem[] {
  return svc
    .listNodesByBranch(branchId)
    .filter((n) => n.branch_id === branchId);
}

// ---------- 结构防护 ----------

/** 判断 targetId 是否在 nodeId 的后代集合中（沿 parent_id 向上爬） */
function isDescendant(targetId: string, nodeId: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = targetId;
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return false; // 数据损坏防环
    seen.add(cur);
    const n = svc.getNodeRaw(cur);
    if (!n) return false;
    cur = n.parent_id;
  }
  return false;
}

/** 孤儿检测：节点必须能沿 parent_id 链回到一个 branch_id 为 null 的主线节点 */
function hasPathToTrunk(node: NodeItem): boolean {
  const seen = new Set<string>();
  let cur: NodeItem | undefined = node;
  while (cur) {
    if (!cur.branch_id) return true; // 到达主线
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    if (!cur.parent_id) return false;
    cur = svc.getNodeRaw(cur.parent_id);
  }
  return false;
}

/**
 * 分支完成状态对主线门控的统一判定：
 * 返回 { gated, unfinished } —— gated 为 true 时禁止在该分叉点之后的主线追加新步骤。
 */
export function gatingAt(forkNodeId: string): { gated: boolean; unfinished: { id: string; name: string }[] } {
  const branches = branchesAt(forkNodeId);
  const unfinished = branches
    .filter((b) => b.status !== 'done')
    .map((b) => ({ id: b.id, name: b.name }));
  return { gated: unfinished.length > 0, unfinished };
}

/**
 * 检查「在主线某位置之后追加节点」是否被门控。
 * 规则：新节点将排在主线末尾时，检查主干上**每一个**存在分支且未全完成的分叉点，
 * 其后不允许再追加主线步骤（即分支未全部完成的分叉点必须是主干最后一步）。
 */
export function checkMainlineAppend(workflowId: string): { allowed: boolean; blockers: { forkNodeId: string; forkTitle: string; unfinished: { id: string; name: string }[] }[] } {
  const blockers: { forkNodeId: string; forkTitle: string; unfinished: { id: string; name: string }[] }[] = [];
  const trunk = getDb()
    .prepare("SELECT id, title FROM node WHERE workflow_id = ? AND branch_id IS NULL AND deleted_at IS NULL ORDER BY sort_order, created_at")
    .all(workflowId) as unknown as { id: string; title: string }[];
  // 任意主干节点若有未完成分支，即阻塞后续追加；用于显示所有待完成分叉点。
  for (let i = 0; i < trunk.length; i++) {
    const g = gatingAt(trunk[i].id);
    if (g.gated) {
      blockers.push({ forkNodeId: trunk[i].id, forkTitle: trunk[i].title, unfinished: g.unfinished });
    }
  }
  return { allowed: blockers.length === 0, blockers };
}

/** 导入器专用：插入已校验并完成 id 映射的分支行。 */
export function importBranchRow(input: {
  id: string; workflow_id: string; fork_node_id: string; name: string;
  status: 'active' | 'done'; completed_at: string | null; sort_order: number; extra_json?: string | null;
}): BranchItem {
  const t = nowISO();
  withTx(() => {
    getDb().prepare('INSERT INTO branch(id, workflow_id, fork_node_id, name, status, completed_at, sort_order, created_at, updated_at, extra_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(input.id, input.workflow_id, input.fork_node_id, input.name, input.status, input.completed_at, input.sort_order, t, t, input.extra_json ?? null);
  });
  return { ...input, created_at: t, updated_at: t, deleted_at: null };
}

// ---------- 创建分支 ----------

/**
 * 在指定节点（将成为分叉点）下创建 N 条并行分支（N≥2）。
 * 每条分支自动创建一个根节点（默认标题「开始」+ 分支名）。
 * 返回创建的分支与各自根节点。
 */
export function createBranches(
  workflowId: string,
  forkNodeId: string,
  branchNames: string[],
  rootTitle?: string
): { branches: BranchItem[]; roots: NodeItem[] } {
  const fork = svc.getNode(forkNodeId);
  if (!fork) throw new Error('分叉点节点不存在或已删除');
  if (fork.workflow_id !== workflowId) throw new Error('分叉点不属于该流程');
  if (fork.branch_id) {
    const parentBranch = getBranch(fork.branch_id);
    if (!parentBranch) throw new Error('分叉点所属分支不存在或已删除');
    if (parentBranch.status === 'done') throw new Error(`所属分支「${parentBranch.name}」已完成，请先取消完成标记再创建嵌套分支`);
  }
  const names = branchNames.map((s) => String(s).trim()).filter(Boolean);
  if (names.length < 2) throw new Error('并行分支至少需要 2 条');

  const branches: BranchItem[] = [];
  const roots: NodeItem[] = [];
  withTx(() => {
    // 若分叉点已在某条分支内（嵌套分叉），新分支挂到该分支所在分叉点之下同理；
    // 分支的 fork_node_id 指向分叉点节点本身。
    const max = getDb()
      .prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM branch WHERE fork_node_id = ? AND deleted_at IS NULL')
      .get(forkNodeId) as { m: number };
    names.forEach((name, i) => {
      const b: BranchItem = {
        id: uuid(),
        workflow_id: workflowId,
        fork_node_id: forkNodeId,
        name,
        status: 'active',
        completed_at: null,
        sort_order: max.m + 1 + i,
        created_at: nowISO(),
        updated_at: nowISO(),
        deleted_at: null
      };
      getDb()
        .prepare(
          'INSERT INTO branch(id, workflow_id, fork_node_id, name, status, completed_at, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
        )
        .run(b.id, b.workflow_id, b.fork_node_id, b.name, b.status, b.completed_at, b.sort_order, b.created_at, b.updated_at);
      branches.push(b);
      // 分支根节点：parent 指向分叉点
      const root = svc.createNodeInCurrentTx(
        workflowId, rootTitle?.trim() || `${name} · 开始`, forkNodeId, b.id, 0
      );
      roots.push(root);
    });
  });
  log.info(`已创建并行分支：分叉点「${fork.title}」下 ${names.length} 条`);
  return { branches, roots };
}

// ---------- 分支内追加 ----------

/** 在指定分支末尾追加一个节点（分支隔离 + 门控检查在调用侧针对主线） */
export function appendToBranch(branchId: string, title: string, note?: string): NodeItem {
  const b = getBranch(branchId);
  if (!b) throw new Error('分支不存在或已删除');
  if (b.status === 'done') throw new Error(`分支「${b.name}」已完成，请先取消完成标记再添加步骤`);
  const blocker = getDb().prepare(`
    SELECT n.title AS fork_title, GROUP_CONCAT(child.name, '、') AS names
    FROM node n JOIN branch child ON child.fork_node_id = n.id
    WHERE n.branch_id = ? AND n.deleted_at IS NULL
      AND child.deleted_at IS NULL AND child.status != 'done'
    GROUP BY n.id ORDER BY n.sort_order LIMIT 1
  `).get(branchId) as { fork_title: string; names: string } | undefined;
  if (blocker) throw new Error(`分支「${b.name}」暂不能继续：分叉点「${blocker.fork_title}」还有未完成分支：${blocker.names}`);
  // 分支内由 branch_id + sort_order 排序，parent_id 始终指向该分支的分叉点。
  return svc.createNode(b.workflow_id, title, note, { parentId: b.fork_node_id, branchId });
}

// ---------- 完成标记 ----------

/** 递归收集当前分支子树中未完成的嵌套分支。 */
function unfinishedNested(branchId: string, seen = new Set<string>()): BranchItem[] {
  if (seen.has(branchId)) return [];
  seen.add(branchId);
  const out: BranchItem[] = [];
  for (const n of branchNodes(branchId)) {
    for (const child of branchesAt(n.id)) {
      if (child.status !== 'done') out.push(child);
      out.push(...unfinishedNested(child.id, seen));
    }
  }
  return out;
}

/** 显式标记分支完成（可见反馈由界面给出；可撤销）。内层分支未完成时不允许完成外层分支。 */
export function setBranchStatus(branchId: string, status: 'active' | 'done'): BranchItem {
  const b = getBranch(branchId);
  if (!b) throw new Error('分支不存在或已删除');
  if (status === 'done') {
    const pending = unfinishedNested(branchId);
    if (pending.length) throw new Error(`分支「${b.name}」还有未完成的嵌套分支：${pending.map((x) => x.name).join('、')}`);
  }
  withTx(() => {
    getDb()
      .prepare('UPDATE branch SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'done' ? nowISO() : null, nowISO(), branchId);
  });
  log.info(`分支「${b.name}」状态 → ${status === 'done' ? '已完成' : '进行中'}`);
  return getBranch(branchId)!;
}

// ---------- 重命名 / 删除 ----------

export function renameBranch(branchId: string, name: string): void {
  const b = getBranch(branchId);
  if (!b) throw new Error('分支不存在或已删除');
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error('分支名称不能为空');
  withTx(() => {
    getDb().prepare('UPDATE branch SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, nowISO(), branchId);
  });
  log.info(`分支重命名：${b.name} → ${trimmed}`);
}

/**
 * 删除分支：先确认其节点（根 + 后继）一并软删。
 * 含子分支（嵌套分叉）时必须显式确认 cascade，否则拒绝。
 */
export function deleteBranch(branchId: string, opts?: { confirmedCascade?: boolean }): { removedNodes: number } {
  const b = getBranch(branchId);
  if (!b) throw new Error('分支不存在或已删除');
  const nodes = svc.listNodesByBranch(branchId).filter((n) => n.branch_id === branchId);
  const children = nodes.flatMap((n) => branchesAt(n.id));
  // 分支总有根步骤或后续步骤；只要含节点，删除就必须经 UI 明确确认。
  if ((nodes.length > 0 || children.length > 0) && !opts?.confirmedCascade) {
    throw new Error(`分支「${b.name}」含 ${nodes.length} 个步骤及 ${children.length} 条嵌套分支，必须明确确认后删除`);
  }
  const t = nowISO();
  const removed = { count: 0 };
  withTx(() => deleteBranchInner(branchId, t, removed, new Set<string>()));
  log.info(`分支已删除：「${b.name}」（含 ${removed.count} 个节点）`);
  return { removedNodes: removed.count };
}

function deleteBranchInner(branchId: string, t: string, removed: { count: number }, seen: Set<string>): void {
  if (seen.has(branchId)) return;
  seen.add(branchId);
  const b = getBranch(branchId);
  if (!b) return;
  const nodes = svc.listNodesByBranch(branchId).filter((n) => n.branch_id === branchId);
  for (const n of nodes) {
    for (const child of branchesAt(n.id)) deleteBranchInner(child.id, t, removed, seen);
    getDb().prepare('UPDATE node SET deleted_at = ?, updated_at = ? WHERE id = ?').run(t, t, n.id);
    getDb().prepare('UPDATE attachment SET deleted_at = ? WHERE node_id = ? AND deleted_at IS NULL').run(t, n.id);
    removed.count++;
  }
  getDb().prepare('UPDATE branch SET deleted_at = ?, updated_at = ? WHERE id = ?').run(t, t, branchId);
}

// ---------- 回收站：分支整体还原 / 彻底删除 ----------

/** 还原已删除分支：分叉点须仍存在，否则拒绝（防孤儿）；同批删除的节点与嵌套分支一并还原 */
export function restoreBranch(branchId: string): void {
  const row = getDb().prepare('SELECT * FROM branch WHERE id = ?').get(branchId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('分支不存在');
  const b = rowToBranch(row);
  if (!b.deleted_at) return;
  const fork = svc.getNode(b.fork_node_id);
  if (!fork) throw new Error(`分支「${b.name}」的分叉点已被删除，请先还原分叉点所在步骤`);
  if (fork.branch_id) {
    const parentBranch = getBranch(fork.branch_id);
    if (!parentBranch || parentBranch.status === 'done') throw new Error(`分支「${b.name}」的父分支已完成或已删除，请先恢复父分支状态`);
  }
  withTx(() => restoreBranchInner(b.id, b.deleted_at!, new Set<string>()));
  log.info(`分支已从回收站还原：「${b.name}」`);
}

function restoreBranchInner(branchId: string, stamp: string, seen: Set<string>): void {
  if (seen.has(branchId)) return;
  seen.add(branchId);
  getDb().prepare('UPDATE branch SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(nowISO(), branchId);
  const ids = (getDb()
    .prepare('SELECT id FROM node WHERE branch_id = ? AND deleted_at = ?')
    .all(branchId, stamp) as unknown as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    getDb().prepare('UPDATE node SET deleted_at = NULL WHERE id = ?').run(id);
    getDb().prepare('UPDATE attachment SET deleted_at = NULL WHERE node_id = ? AND deleted_at = ?').run(id, stamp);
    const kids = getDb()
      .prepare('SELECT id FROM branch WHERE fork_node_id = ? AND deleted_at = ?')
      .all(id, stamp) as unknown as { id: string }[];
    for (const k of kids) restoreBranchInner(k.id, stamp, seen);
  }
}

/** 彻底删除分支（含其节点与嵌套分支）。返回受影响 sha256，供实体引用清理 */
export function purgeBranch(branchId: string): string[] {
  const shas = new Set<string>();
  const seen = new Set<string>();
  const collect = (bid: string, acc: { branches: string[]; nodes: string[] }): void => {
    if (seen.has(bid)) return;
    seen.add(bid);
    acc.branches.push(bid);
    const ns = getDb().prepare('SELECT id FROM node WHERE branch_id = ?').all(bid) as unknown as { id: string }[];
    for (const n of ns) {
      acc.nodes.push(n.id);
      const kids = getDb().prepare('SELECT id FROM branch WHERE fork_node_id = ?').all(n.id) as unknown as { id: string }[];
      for (const k of kids) collect(k.id, acc);
    }
  };
  const acc = { branches: [] as string[], nodes: [] as string[] };
  collect(branchId, acc);
  for (const nid of acc.nodes) {
    const rows = getDb().prepare('SELECT DISTINCT sha256 FROM attachment WHERE node_id = ?').all(nid) as unknown as { sha256: string }[];
    rows.forEach((r) => shas.add(r.sha256));
  }
  withTx(() => {
    for (const bid of acc.branches) getDb().prepare('DELETE FROM branch WHERE id = ?').run(bid);
    for (const nid of acc.nodes) getDb().prepare('DELETE FROM node WHERE id = ?').run(nid);
  });
  log.info(`分支已彻底删除：${branchId}（${acc.nodes.length} 个节点）`);
  return [...shas];
}

// ---------- 结构调整：把整条分支挂到另一个分叉点（含环检测） ----------

/** 移动分支到新的分叉点。目标是该分支自身或其嵌套分支内的节点时拒绝（会形成环） */
export function moveBranch(branchId: string, newForkNodeId: string): void {
  const b = getBranch(branchId);
  if (!b) throw new Error('分支不存在或已删除');
  const target = svc.getNode(newForkNodeId);
  if (!target) throw new Error('目标节点不存在或已删除');
  if (target.workflow_id !== b.workflow_id) throw new Error('不能把分支移动到其他流程');
  // 收集该分支子树内全部节点
  const inTree = new Set<string>();
  const seenBranches = new Set<string>();
  const walk = (bid: string): void => {
    if (seenBranches.has(bid)) return;
    seenBranches.add(bid);
    for (const n of svc.listNodesByBranch(bid)) {
      inTree.add(n.id);
      for (const k of branchesAt(n.id)) walk(k.id);
    }
  };
  walk(branchId);
  if (inTree.has(newForkNodeId)) throw new Error('不能把分支移动到它自己或其后代步骤之下（会形成环）');
  if (target.branch_id) {
    const parentBranch = getBranch(target.branch_id);
    if (!parentBranch || parentBranch.status === 'done') throw new Error('不能把分支移动到已完成或已删除的父分支中');
  }
  withTx(() => {
    const max = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM branch WHERE fork_node_id = ? AND deleted_at IS NULL AND id != ?').get(newForkNodeId, branchId) as { m: number };
    getDb().prepare('UPDATE branch SET fork_node_id = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(newForkNodeId, max.m + 1, nowISO(), branchId);
    getDb().prepare('UPDATE node SET parent_id = ? WHERE branch_id = ?').run(newForkNodeId, branchId);
  });
  log.info(`分支「${b.name}」已移动到「${target.title}」下`);
}

// ---------- 校验工具（环 / 孤儿，供测试与维护使用） ----------

/** 全库结构校验：返回问题清单（环、孤儿） */
export function validateWorkflowTree(workflowId: string): { cycles: string[]; orphans: string[] } {
  const nodes = svc.listNodes(workflowId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cycles: string[] = [];
  const orphans: string[] = [];
  for (const n of nodes) {
    // 环检测：沿 parent 链走，重复访问即环
    const seen = new Set<string>([n.id]);
    let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
    let cyclic = false;
    while (cur) {
      if (seen.has(cur.id)) {
        cyclic = true;
        break;
      }
      seen.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    if (cyclic) cycles.push(n.id);
    // 孤儿：分支节点必须能回溯到主线；主线节点不能有 parent
    if (n.branch_id && !hasPathToTrunk(n)) orphans.push(n.id);
    if (!n.branch_id && n.parent_id) orphans.push(n.id);
  }
  return { cycles, orphans };
}

/** 防环校验：把 child 的 parent 设为 target 是否成环 */
export function wouldCycle(childId: string, targetParentId: string): boolean {
  return childId === targetParentId || isDescendant(targetParentId, childId);
}

export { isDescendant, hasPathToTrunk };

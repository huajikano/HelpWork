// 业务服务层：流程/节点/附件/搜索/回收站的全部数据操作
// 所有写操作都在 withTx 事务中；查询排除软删除行
import { getDb, withTx } from './db';
import { uuid, nowISO } from './util';
import { log } from './logger';
import type { Workflow, NodeItem, Attachment, SearchHit, RecycleItem } from '../shared/types';

/** 把 SELECT * 返回的未知 SQLite 列合并进扩展袋，避免后续导出丢失未知字段。 */
export function preserveUnknownColumns(row: Record<string, unknown>, known: readonly string[]): string | null {
  let extra: Record<string, unknown> = {};
  if (typeof row.extra_json === 'string') {
    try {
      const parsed = JSON.parse(row.extra_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed as Record<string, unknown>;
    } catch { /* 不覆盖无法解析的扩展袋；原值将在下一次保存前仍保留于行内 */ }
  }
  const knownSet = new Set(known);
  for (const [key, value] of Object.entries(row)) {
    if (!knownSet.has(key) && key !== 'extra_json') extra[key] = value;
  }
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

// ---------- 工具 ----------

/** SQL LIKE 转义（\ % _） */
function escLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 节点数统计（按流程分组，未删除节点） */
function nodeCountMap(): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT workflow_id, COUNT(*) c FROM node WHERE deleted_at IS NULL GROUP BY workflow_id')
    .all() as unknown as { workflow_id: string; c: number }[];
  return new Map(rows.map((r) => [r.workflow_id, r.c]));
}

/** 附件数统计（按节点分组，未删除附件） */
function attCountMap(): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT node_id, COUNT(*) c FROM attachment WHERE deleted_at IS NULL GROUP BY node_id')
    .all() as unknown as { node_id: string; c: number }[];
  return new Map(rows.map((r) => [r.node_id, r.c]));
}

// ---------- 流程 ----------

export function listWorkflows(): Workflow[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow WHERE deleted_at IS NULL ORDER BY sort_order, created_at')
    .all() as unknown as Workflow[];
  const counts = nodeCountMap();
  for (const w of rows) {
    w.node_count = counts.get(w.id) ?? 0;
    w.extra_json = preserveUnknownColumns(w as unknown as Record<string, unknown>, ['id', 'name', 'description', 'sort_order', 'created_at', 'updated_at', 'deleted_at', 'node_count', 'extra_json']);
  }
  return rows;
}

export function getWorkflow(id: string): Workflow | undefined {
  const w = getDb().prepare('SELECT * FROM workflow WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as Workflow | undefined;
  if (w) w.extra_json = preserveUnknownColumns(w as unknown as Record<string, unknown>, ['id', 'name', 'description', 'sort_order', 'created_at', 'updated_at', 'deleted_at', 'extra_json']);
  return w;
}

/** 设置未知 JSON 字段透传袋（用于导入/导出时无损保留扩展字段）。 */
export function updateWorkflowExtraJson(id: string, json: string | null): void {
  withTx(() => getDb().prepare('UPDATE workflow SET extra_json = ? WHERE id = ?').run(json, id));
}

export function updateNodeExtraJson(id: string, json: string | null): void {
  withTx(() => getDb().prepare('UPDATE node SET extra_json = ? WHERE id = ?').run(json, id));
}

export function createWorkflow(name: string, description?: string): Workflow {
  const w: Workflow = {
    id: uuid(),
    name,
    description: description ?? null,
    sort_order: 0,
    created_at: nowISO(),
    updated_at: nowISO(),
    deleted_at: null
  };
  withTx(() => {
    const max = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM workflow WHERE deleted_at IS NULL').get() as {
      m: number;
    };
    w.sort_order = max.m + 1;
    getDb()
      .prepare('INSERT INTO workflow(id, name, description, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?)')
      .run(w.id, w.name, w.description, w.sort_order, w.created_at, w.updated_at);
  });
  log.info(`新建流程：${name}`);
  return w;
}

export function renameWorkflow(id: string, name: string): void {
  withTx(() => {
    getDb().prepare('UPDATE workflow SET name = ?, updated_at = ? WHERE id = ?').run(name, nowISO(), id);
  });
  log.info(`流程重命名：${id} → ${name}`);
}

/** 删除流程（软删，连带未删除的节点与附件一起进回收站） */
export function deleteWorkflow(id: string): void {
  const t = nowISO();
  withTx(() => {
    getDb().prepare('UPDATE workflow SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(t, t, id);
    const nodes = getDb().prepare('SELECT id FROM node WHERE workflow_id = ? AND deleted_at IS NULL').all(id) as unknown as {
      id: string;
    }[];
    for (const n of nodes) {
      getDb().prepare('UPDATE node SET deleted_at = ?, updated_at = ? WHERE id = ?').run(t, t, n.id);
      getDb().prepare('UPDATE attachment SET deleted_at = ? WHERE node_id = ? AND deleted_at IS NULL').run(t, n.id);
    }
  });
  log.info(`流程已删除（进回收站）：${id}`);
}

export function reorderWorkflows(ids: string[]): void {
  withTx(() => {
    ids.forEach((id, i) => {
      getDb().prepare('UPDATE workflow SET sort_order = ? WHERE id = ?').run(i, id);
    });
  });
  log.info(`流程排序已保存（${ids.length} 项）`);
}

/**
 * 彻底删除流程：删行（FK 级联删 node/attachment 行）。
 * 返回受影响的 sha256 集合，供外层做引用计数清理实体文件。
 */
export function purgeWorkflow(id: string): string[] {
  const shas = getDb()
    .prepare('SELECT DISTINCT a.sha256 FROM attachment a JOIN node n ON a.node_id = n.id WHERE n.workflow_id = ?')
    .all(id) as unknown as { sha256: string }[];
  withTx(() => {
    getDb().prepare('DELETE FROM workflow WHERE id = ?').run(id);
  });
  log.info(`流程已彻底删除：${id}`);
  return shas.map((r) => r.sha256);
}

/** 回收站还原流程：放回列表末尾；其下节点一并还原 */
export function restoreWorkflow(id: string): void {
  const t = nowISO();
  withTx(() => {
    const m = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM workflow WHERE deleted_at IS NULL').get() as {
      m: number;
    };
    getDb()
      .prepare('UPDATE workflow SET deleted_at = NULL, sort_order = ?, updated_at = ? WHERE id = ?')
      .run(m.m + 1, t, id);
    // 还原随流程一起被删的节点（deleted_at 与流程相同的批次）——
    // 简化策略：还原该流程下所有处于回收站的节点（用户视角："还原流程"应恢复整棵树）
    getDb()
      .prepare('UPDATE node SET deleted_at = NULL, updated_at = ? WHERE workflow_id = ? AND deleted_at IS NOT NULL')
      .run(t, id);
    getDb().prepare(`
      UPDATE attachment SET deleted_at = NULL
      WHERE deleted_at IS NOT NULL
        AND node_id IN (SELECT id FROM node WHERE workflow_id = ?)
    `).run(id);
  });
  log.info(`流程已从回收站还原：${id}`);
}

// ---------- 节点 ----------

export function listNodes(workflowId: string): NodeItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM node WHERE workflow_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all(workflowId) as unknown as NodeItem[];
  const counts = attCountMap();
  for (const n of rows) {
    // 兼容旧库行：列存在但值为 undefined 时补默认（v2 加载期归一化）
    if (n.parent_id === undefined) n.parent_id = null;
    if (n.branch_id === undefined) n.branch_id = null;
    n.attachment_count = counts.get(n.id) ?? 0;
    n.extra_json = preserveUnknownColumns(n as unknown as Record<string, unknown>, ['id', 'workflow_id', 'title', 'note', 'sort_order', 'parent_id', 'branch_id', 'created_at', 'updated_at', 'deleted_at', 'attachment_count', 'extra_json']);
  }
  return rows;
}

export function getNode(id: string): NodeItem | undefined {
  const n = getDb().prepare('SELECT * FROM node WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as
    | NodeItem
    | undefined;
  if (n) {
    if (n.parent_id === undefined) n.parent_id = null;
    if (n.branch_id === undefined) n.branch_id = null;
    n.extra_json = preserveUnknownColumns(n as unknown as Record<string, unknown>, ['id', 'workflow_id', 'title', 'note', 'sort_order', 'parent_id', 'branch_id', 'created_at', 'updated_at', 'deleted_at', 'extra_json']);
  }
  return n;
}

/** 同 getNode，但不做存在性语义差异（供 branches 层内部链路回溯，含补默认值） */
export function getNodeRaw(id: string): NodeItem | undefined {
  return getNode(id);
}

/** 按分支取节点（含跨分支过滤前的原始列表，branches 层会再过滤） */
export function listNodesByBranch(branchId: string): NodeItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM node WHERE branch_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
    .all(branchId) as unknown as NodeItem[];
  for (const n of rows) {
    if (n.parent_id === undefined) n.parent_id = null;
    if (n.branch_id === undefined) n.branch_id = null;
    n.extra_json = preserveUnknownColumns(n as unknown as Record<string, unknown>, ['id', 'workflow_id', 'title', 'note', 'sort_order', 'parent_id', 'branch_id', 'created_at', 'updated_at', 'deleted_at', 'extra_json']);
  }
  return rows;
}

export function createNode(
  workflowId: string,
  title: string,
  note?: string,
  opts?: { parentId?: string | null; branchId?: string | null }
): NodeItem {
  const branchId = opts?.branchId ?? null;
  if (!branchId) {
    const blocker = getDb().prepare(`
      SELECT n.title AS fork_title, GROUP_CONCAT(b.name, '、') AS names
      FROM node n JOIN branch b ON b.fork_node_id = n.id
      WHERE n.workflow_id = ? AND n.branch_id IS NULL AND n.deleted_at IS NULL
        AND b.deleted_at IS NULL AND b.status != 'done'
      GROUP BY n.id ORDER BY n.sort_order LIMIT 1
    `).get(workflowId) as { fork_title: string; names: string } | undefined;
    if (blocker) throw new Error(`主线暂不能继续：分叉点「${blocker.fork_title}」还有未完成分支：${blocker.names}`);
  }
  if (branchId) {
    const branch = getDb().prepare('SELECT name, status, deleted_at FROM branch WHERE id = ?').get(branchId) as
      | { name: string; status: string; deleted_at: string | null }
      | undefined;
    if (!branch || branch.deleted_at) throw new Error('分支不存在或已删除，无法继续记录');
    if (branch.status === 'done') throw new Error(`分支「${branch.name}」已完成，请先取消完成标记再添加步骤`);
    const relation = getDb().prepare('SELECT workflow_id, fork_node_id FROM branch WHERE id = ?').get(branchId) as
      | { workflow_id: string; fork_node_id: string }
      | undefined;
    if (!relation || relation.workflow_id !== workflowId) throw new Error('分支不属于当前流程');
    if ((opts?.parentId ?? null) !== relation.fork_node_id) throw new Error('节点挂接点与所属分支不匹配');
    const nested = getDb().prepare(`
      SELECT GROUP_CONCAT(child.name, '、') AS names
      FROM branch child JOIN node fork ON fork.id = child.fork_node_id
      WHERE fork.branch_id = ? AND fork.deleted_at IS NULL
        AND child.deleted_at IS NULL AND child.status != 'done'
    `).get(branchId) as { names: string | null };
    if (nested.names) throw new Error(`分支「${branch.name}」暂不能继续：还有未完成的嵌套分支（${nested.names}）`);
  }
  const n: NodeItem = {
    id: uuid(),
    workflow_id: workflowId,
    title,
    note: note ?? null,
    sort_order: 0,
    parent_id: opts?.parentId ?? null,
    branch_id: opts?.branchId ?? null,
    created_at: nowISO(),
    updated_at: nowISO(),
    deleted_at: null
  };
  withTx(() => {
    const sql = 'INSERT INTO node(id, workflow_id, title, note, sort_order, parent_id, branch_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)';
    let args: (string | number | null)[];
    if (n.branch_id) {
      // 分支内步骤：同一分支内排到末尾
      const max = getDb()
        .prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM node WHERE branch_id = ? AND deleted_at IS NULL')
        .get(n.branch_id) as { m: number };
      n.sort_order = max.m + 1;
      args = [n.id, n.workflow_id, n.title, n.note, n.sort_order, n.parent_id, n.branch_id, n.created_at, n.updated_at];
    } else {
      // 主线步骤：流程内排到末尾
      const max = getDb()
        .prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM node WHERE workflow_id = ? AND branch_id IS NULL AND deleted_at IS NULL')
        .get(workflowId) as { m: number };
      n.sort_order = max.m + 1;
      args = [n.id, n.workflow_id, n.title, n.note, n.sort_order, null, null, n.created_at, n.updated_at];
    }
    getDb().prepare(sql).run(...args);
  });
  log.info(`新建节点：${title}${n.branch_id ? '（分支内）' : ''}`);
  return n;
}

export function createNodeWithOrder(
  workflowId: string,
  title: string,
  note: string | undefined,
  sortOrder: number,
  relations: { parentId: string | null; branchId: string | null }
): NodeItem {
  const n: NodeItem = {
    id: uuid(), workflow_id: workflowId, title, note: note ?? null, sort_order: sortOrder,
    parent_id: relations.parentId, branch_id: relations.branchId,
    created_at: nowISO(), updated_at: nowISO(), deleted_at: null
  };
  withTx(() => {
    getDb().prepare('INSERT INTO node(id, workflow_id, title, note, sort_order, parent_id, branch_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(n.id, n.workflow_id, n.title, n.note, n.sort_order, n.parent_id, n.branch_id, n.created_at, n.updated_at);
  });
  return n;
}

/** 导入 v2 结构时写入关系字段；导入器已先完成结构校验与 id 映射。 */
export function updateNodeRelations(id: string, rel: { parent_id: string | null; branch_id: string | null }): void {
  const node = getNode(id);
  if (!node) throw new Error('导入节点不存在');
  if (rel.branch_id) {
    const b = getDb().prepare('SELECT workflow_id, fork_node_id, deleted_at FROM branch WHERE id = ?').get(rel.branch_id) as
      | { workflow_id: string; fork_node_id: string; deleted_at: string | null }
      | undefined;
    if (!b || b.deleted_at || b.workflow_id !== node.workflow_id) throw new Error('导入节点所属分支不存在或不属于该流程');
    if (rel.parent_id !== b.fork_node_id) throw new Error('导入节点 parent_id 与分支分叉点不匹配');
    if (!getNode(rel.parent_id)) throw new Error('导入节点分叉点不存在或已删除');
  } else if (rel.parent_id) {
    throw new Error('主线节点 parent_id 必须为空');
  }
  withTx(() => {
    getDb().prepare('UPDATE node SET parent_id = ?, branch_id = ?, updated_at = ? WHERE id = ?')
      .run(rel.parent_id, rel.branch_id, nowISO(), id);
  });
}

/** 导入 v2 时创建分支行（id、顺序与完成状态由导入包映射后传入）。 */
export function insertBranchRow(input: {
  id: string; workflow_id: string; fork_node_id: string; name: string;
  status: 'active' | 'done'; completed_at: string | null; sort_order: number;
}): void {
  const t = nowISO();
  withTx(() => {
    getDb().prepare('INSERT INTO branch(id, workflow_id, fork_node_id, name, status, completed_at, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(input.id, input.workflow_id, input.fork_node_id, input.name, input.status, input.completed_at, input.sort_order, t, t);
  });
}

export function createNodeInCurrentTx(
  workflowId: string, title: string, parentId: string | null, branchId: string | null, sortOrder: number
): NodeItem {
  const n: NodeItem = { id: uuid(), workflow_id: workflowId, title, note: null, sort_order: sortOrder,
    parent_id: parentId, branch_id: branchId, created_at: nowISO(), updated_at: nowISO(), deleted_at: null };
  getDb().prepare('INSERT INTO node(id, workflow_id, title, note, sort_order, parent_id, branch_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(n.id, n.workflow_id, n.title, n.note, n.sort_order, n.parent_id, n.branch_id, n.created_at, n.updated_at);
  return n;
}

export function updateNode(id: string, patch: { title?: string; note?: string }): void {
  withTx(() => {
    if (patch.title !== undefined) {
      getDb().prepare('UPDATE node SET title = ?, updated_at = ? WHERE id = ?').run(patch.title, nowISO(), id);
    }
    if (patch.note !== undefined) {
      getDb().prepare('UPDATE node SET note = ?, updated_at = ? WHERE id = ?').run(patch.note, nowISO(), id);
    }
  });
}

/** 删除节点（软删，附件一并进回收站）。作为分叉点的节点必须先处理其分支。 */
export function deleteNode(id: string): void {
  const t = nowISO();
  withTx(() => {
    const forks = getDb()
      .prepare('SELECT COUNT(*) c FROM branch WHERE fork_node_id = ? AND deleted_at IS NULL')
      .get(id) as { c: number };
    if (forks.c > 0) throw new Error(`该节点下还有 ${forks.c} 条并行分支，请先删除这些分支`);
    getDb().prepare('UPDATE node SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(t, t, id);
    getDb().prepare('UPDATE attachment SET deleted_at = ? WHERE node_id = ? AND deleted_at IS NULL').run(t, id);
  });
  log.info(`节点已删除（进回收站）：${id}`);
}

/** 上移/下移（delta = -1 / +1），交换相邻两个节点的 sort_order（仅同层：主线内或同一分支内） */
export function moveNode(id: string, delta: -1 | 1): boolean {
  const cur = getNode(id);
  if (!cur) return false;
  const rows = (
    cur.branch_id
      ? getDb()
          .prepare('SELECT id FROM node WHERE branch_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at')
          .all(cur.branch_id)
      : getDb()
          .prepare('SELECT id FROM node WHERE workflow_id = ? AND branch_id IS NULL AND deleted_at IS NULL ORDER BY sort_order, created_at')
          .all(cur.workflow_id)
  ) as unknown as { id: string }[];
  const idx = rows.findIndex((r) => r.id === id);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= rows.length) return false;
  // 交换后重写整列表顺序
  const ids = rows.map((r) => r.id);
  [ids[idx], ids[target]] = [ids[target], ids[idx]];
  withTx(() => {
    ids.forEach((nid, i) => {
      getDb().prepare('UPDATE node SET sort_order = ? WHERE id = ?').run(i, nid);
    });
  });
  return true;
}

export function reorderNodes(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('节点排序列表包含重复 id');
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id, workflow_id, parent_id, branch_id FROM node WHERE deleted_at IS NULL AND id IN (${placeholders})`).all(...ids) as unknown as
    { id: string; workflow_id: string; parent_id: string | null; branch_id: string | null }[];
  if (rows.length !== ids.length) throw new Error('节点排序列表包含不存在或已删除的节点');
  const first = rows[0];
  if (rows.some((r) => r.workflow_id !== first.workflow_id || r.parent_id !== first.parent_id || r.branch_id !== first.branch_id)) {
    throw new Error('只能在同一主线或同一分支中调整节点顺序');
  }
  withTx(() => {
    ids.forEach((id, i) => {
      getDb().prepare('UPDATE node SET sort_order = ? WHERE id = ?').run(i, id);
    });
  });
  log.info(`节点排序已保存（${ids.length} 项）`);
}

/** 彻底删除节点：删行（FK 级联删附件行）。返回受影响 sha256 集合。 */
export function purgeNode(id: string): string[] {
  const forks = getDb().prepare('SELECT COUNT(*) c FROM branch WHERE fork_node_id = ?').get(id) as { c: number };
  if (forks.c > 0) throw new Error(`该节点是 ${forks.c} 条并行分支的分叉点，请先彻底删除这些分支`);
  const shas = getDb().prepare('SELECT DISTINCT sha256 FROM attachment WHERE node_id = ?').all(id) as unknown as {
    sha256: string;
  }[];
  withTx(() => {
    getDb().prepare('DELETE FROM node WHERE id = ?').run(id);
  });
  log.info(`节点已彻底删除：${id}`);
  return shas.map((r) => r.sha256);
}

/**
 * 回收站还原节点：附件一并还原。
 * 主线节点放回主线末尾；分支内节点若所属分支仍存在则放回该分支末尾，
 * 分支已删除或不存在时回落为主线节点（孤儿防护）。
 */
export function restoreNode(id: string): { workflow_id: string } | undefined {
  const row = getDb().prepare('SELECT workflow_id, branch_id, parent_id FROM node WHERE id = ?').get(id) as unknown as
    | { workflow_id: string; branch_id: string | null; parent_id: string | null }
    | undefined;
  if (!row) return undefined;
  const t = nowISO();
  withTx(() => {
    let branchId: string | null = row.branch_id ?? null;
    if (branchId) {
      const b = getDb().prepare('SELECT deleted_at, workflow_id, fork_node_id FROM branch WHERE id = ?').get(branchId) as unknown as
        | { deleted_at: string | null; workflow_id: string; fork_node_id: string }
        | undefined;
      const parent = row.parent_id ? getNode(row.parent_id) : undefined;
      if (!b || b.deleted_at || b.workflow_id !== row.workflow_id || b.fork_node_id !== row.parent_id || !parent) branchId = null;
    }
    const m = branchId
      ? (getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM node WHERE branch_id = ? AND deleted_at IS NULL').get(branchId) as { m: number })
      : (getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM node WHERE workflow_id = ? AND branch_id IS NULL AND deleted_at IS NULL').get(row.workflow_id) as { m: number });
    const parentId = branchId ? row.parent_id : null;
    getDb()
      .prepare('UPDATE node SET deleted_at = NULL, sort_order = ?, branch_id = ?, parent_id = ?, updated_at = ? WHERE id = ?')
      .run(m.m + 1, branchId, parentId, t, id);
    getDb().prepare('UPDATE attachment SET deleted_at = NULL WHERE node_id = ? AND deleted_at IS NOT NULL').run(id);
  });
  log.info(`节点已从回收站还原：${id}`);
  return { workflow_id: row.workflow_id };
}

// ---------- 附件 ----------

export function listAttachments(nodeId: string): Attachment[] {
  const rows = getDb()
    .prepare('SELECT * FROM attachment WHERE node_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(nodeId) as unknown as Attachment[];
  for (const a of rows) a.extra_json = preserveUnknownColumns(a as unknown as Record<string, unknown>, ['id', 'node_id', 'sha256', 'original_name', 'stored_path', 'size', 'ext', 'created_at', 'deleted_at', 'extra_json']);
  return rows;
}

export function getAttachment(id: string): Attachment | undefined {
  return getDb().prepare('SELECT * FROM attachment WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as
    | Attachment
    | undefined;
}

/** 新建附件行（实体文件已由 files.storeFile 复制完成） */
export function addAttachmentRow(a: Omit<Attachment, 'deleted_at'>): Attachment {
  withTx(() => {
    getDb()
      .prepare('INSERT INTO attachment(id, node_id, sha256, original_name, stored_path, size, ext, created_at, extra_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.node_id, a.sha256, a.original_name, a.stored_path, a.size, a.ext, a.created_at, a.extra_json ?? null);
  });
  return { ...a, deleted_at: null };
}

export function renameAttachment(id: string, newName: string): void {
  withTx(() => {
    getDb().prepare('UPDATE attachment SET original_name = ? WHERE id = ?').run(newName, id);
  });
  log.info(`附件显示名已更改：${id} → ${newName}`);
}

/** 移除附件（软删进回收站） */
export function removeAttachment(id: string): void {
  withTx(() => {
    getDb().prepare('UPDATE attachment SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(nowISO(), id);
  });
  log.info(`附件已移除（进回收站）：${id}`);
}

/** 彻底删除附件行。返回该行 sha256 供引用计数清理。 */
export function purgeAttachment(id: string): string | undefined {
  const row = getDb().prepare('SELECT sha256 FROM attachment WHERE id = ?').get(id) as unknown as
    | { sha256: string }
    | undefined;
  withTx(() => {
    getDb().prepare('DELETE FROM attachment WHERE id = ?').run(id);
  });
  return row?.sha256;
}

/** 回收站还原附件 */
export function restoreAttachment(id: string): void {
  withTx(() => {
    getDb().prepare('UPDATE attachment SET deleted_at = NULL WHERE id = ?').run(id);
  });
  log.info(`附件已从回收站还原：${id}`);
}

// ---------- 搜索（LIKE 子串，中英文等价） ----------

export interface SearchOptions {
  limit?: number;
}

/** 跨流程搜索：节点标题 / 备注 / 附件名。返回命中（去重到节点级）。 */
export function search(keyword: string, opts?: SearchOptions): SearchHit[] {
  const kw = keyword.trim();
  if (!kw) return [];
  const limit = opts?.limit ?? 100;
  const pat = `%${escLike(kw)}%`;
  const d = getDb();
  const hits: SearchHit[] = [];
  const seen = new Set<string>(); // node_id 去重

  const q = (sql: string, type: SearchHit['match_type']) => {
    const rows = d.prepare(sql).all(pat, limit) as unknown as Record<string, string>[];
    for (const r of rows) {
      if (seen.has(r.node_id)) continue;
      seen.add(r.node_id);
      hits.push({
        workflow_id: r.workflow_id,
        workflow_name: r.workflow_name,
        node_id: r.node_id,
        node_title: r.node_title,
        match_type: type,
        match_text: r.match_text ?? ''
      });
    }
  };

  const baseJoin = `
    FROM node n
    JOIN workflow w ON w.id = n.workflow_id
    WHERE n.deleted_at IS NULL AND w.deleted_at IS NULL`;

  q(
    `SELECT n.id node_id, n.title node_title, w.id workflow_id, w.name workflow_name, n.title match_text ${baseJoin} AND n.title LIKE ? ESCAPE '\\' LIMIT ?`,
    'title'
  );
  q(
    `SELECT n.id node_id, n.title node_title, w.id workflow_id, w.name workflow_name, n.note match_text ${baseJoin} AND n.note LIKE ? ESCAPE '\\' LIMIT ?`,
    'note'
  );
  q(
    `SELECT n.id node_id, n.title node_title, w.id workflow_id, w.name workflow_name, a.original_name match_text
     FROM attachment a JOIN node n ON a.node_id = n.id JOIN workflow w ON w.id = n.workflow_id
     WHERE a.deleted_at IS NULL AND n.deleted_at IS NULL AND w.deleted_at IS NULL AND a.original_name LIKE ? ESCAPE '\\'
     LIMIT ?`,
    'attachment'
  );
  return hits;
}

// ---------- 回收站 ----------

/** 回收站列表：顶层条目（被删流程 + 被删节点 + 被删附件），按删除时间倒序 */
export function listRecycle(): RecycleItem[] {
  const d = getDb();
  const items: RecycleItem[] = [];
  const wfs = d.prepare('SELECT id, name, deleted_at FROM workflow WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as unknown as {
    id: string;
    name: string;
    deleted_at: string;
  }[];
  for (const w of wfs) items.push({ kind: 'workflow', id: w.id, name: w.name, parent_id: null, deleted_at: w.deleted_at });

  const nodes = d.prepare(`
    SELECT n.id, n.title, n.workflow_id, n.deleted_at FROM node n
    WHERE n.deleted_at IS NOT NULL AND n.workflow_id NOT IN (SELECT id FROM workflow WHERE deleted_at IS NOT NULL)
      AND (n.branch_id IS NULL OR n.branch_id NOT IN (SELECT id FROM branch WHERE deleted_at IS NOT NULL))
    ORDER BY n.deleted_at DESC`).all() as unknown as {
    id: string;
    title: string;
    workflow_id: string;
    deleted_at: string;
  }[];
  for (const n of nodes) items.push({ kind: 'node', id: n.id, name: n.title, parent_id: n.workflow_id, deleted_at: n.deleted_at });

  const brs = d.prepare(`
    SELECT b.id, b.name, b.workflow_id, b.deleted_at FROM branch b
    WHERE b.deleted_at IS NOT NULL AND b.workflow_id NOT IN (SELECT id FROM workflow WHERE deleted_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM node fork
        JOIN branch parent_branch ON parent_branch.id = fork.branch_id
        WHERE fork.id = b.fork_node_id AND parent_branch.deleted_at IS NOT NULL
      )
    ORDER BY b.deleted_at DESC`).all() as unknown as {
    id: string;
    name: string;
    workflow_id: string;
    deleted_at: string;
  }[];
  for (const b of brs) items.push({ kind: 'branch', id: b.id, name: b.name, parent_id: b.workflow_id, deleted_at: b.deleted_at });

  const atts = d.prepare(`
    SELECT a.id, a.original_name, a.node_id, a.deleted_at FROM attachment a
    WHERE a.deleted_at IS NOT NULL
      AND a.node_id NOT IN (SELECT id FROM node WHERE deleted_at IS NOT NULL)
    ORDER BY a.deleted_at DESC`).all() as unknown as {
    id: string;
    original_name: string;
    node_id: string;
    deleted_at: string;
  }[];
  for (const a of atts) items.push({ kind: 'attachment', id: a.id, name: a.original_name, parent_id: a.node_id, deleted_at: a.deleted_at });
  return items;
}

/** 清空回收站：彻底删除所有软删行。返回受影响 sha256 集合。 */
export function emptyRecycle(): string[] {
  const d = getDb();
  const shas = (d.prepare('SELECT DISTINCT sha256 FROM attachment WHERE deleted_at IS NOT NULL').all() as unknown as {
    sha256: string;
  }[]).map((r) => r.sha256);
  withTx(() => {
    // 先删软删附件行 → 再删软删节点行 → 再删软删流程行（避免 FK 约束问题）
    d.prepare('DELETE FROM attachment WHERE deleted_at IS NOT NULL').run();
    // 分支行引用 node（FK），须先删软删分支，再删软删节点
    d.prepare('DELETE FROM branch WHERE deleted_at IS NOT NULL').run();
    d.prepare('DELETE FROM node WHERE deleted_at IS NOT NULL').run();
    d.prepare('DELETE FROM workflow WHERE deleted_at IS NOT NULL').run();
  });
  log.info(`回收站已清空（涉及 ${shas.length} 个附件实体待引用检查）`);
  return shas;
}

/** meta 读写（备份日期等） */
export function getMeta(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  withTx(() => {
    getDb().prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(key, value);
  });
}

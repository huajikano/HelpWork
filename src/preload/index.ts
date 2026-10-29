// Preload：通过 contextBridge 暴露类型安全的窗口 API（仅白名单通道）
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { Workflow, NodeItem, Attachment, SearchHit, RecycleItem, DiskUsage, ImportProgress, BranchItem } from '../shared/types';

/** ipcRenderer.invoke 包装：统一把主进程的 {ok,data|error} 拆包，失败抛中文 Error */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; data?: T; error?: string };
  if (r && r.ok) return r.data as T;
  throw new Error(r?.error || '操作失败');
}

const api = {
  // ---- 应用 ----
  init: (): Promise<{ dataDir: string }> => call(IPC.INIT),
  recoverChoose: (): Promise<string> => call(IPC.RECOVER_CHOOSE),
  recoverDefault: (): Promise<string> => call(IPC.RECOVER_DEFAULT),
  getAppInfo: (): Promise<{ version: string; electron: string; node: string }> => call(IPC.GET_APP_INFO),
  getDataDir: (): Promise<string> => call(IPC.GET_DATA_DIR),
  getDiskUsage: (): Promise<DiskUsage> => call(IPC.GET_DISK_USAGE),
  openPath: (p: string): Promise<boolean> => call(IPC.OPEN_PATH, p),
  openInFolder: (p: string): Promise<boolean> => call(IPC.OPEN_IN_FOLDER, p),
  chooseFiles: (): Promise<string[]> => call(IPC.CHOOSE_FILES),
  chooseImportZip: (): Promise<string | null> => call(IPC.CHOOSE_IMPORT_ZIP),
  selectDirectory: (): Promise<string> => call(IPC.SELECT_DIRECTORY),
  pathForFile: (file: File): Promise<string> => call('app:path-for-file', file),
  flushNote: (): Promise<boolean> => call(IPC.FLUSH_NOTE),

  // ---- 流程 ----
  listWorkflows: (): Promise<Workflow[]> => call(IPC.LIST_WORKFLOWS),
  createWorkflow: (name: string): Promise<Workflow> => call(IPC.CREATE_WORKFLOW, name),
  renameWorkflow: (id: string, name: string): Promise<boolean> => call(IPC.RENAME_WORKFLOW, id, name),
  deleteWorkflow: (id: string): Promise<boolean> => call(IPC.DELETE_WORKFLOW, id),
  reorderWorkflows: (ids: string[]): Promise<boolean> => call(IPC.REORDER_WORKFLOWS, ids),

  // ---- 节点 ----
  listNodes: (wfId: string): Promise<NodeItem[]> => call(IPC.LIST_NODES, wfId),
  createNode: (wfId: string, title: string, opts?: { parentId?: string | null; branchId?: string | null }): Promise<NodeItem> =>
    call(IPC.CREATE_NODE, wfId, title, opts),
  updateNode: (id: string, patch: { title?: string; note?: string }): Promise<boolean> => call(IPC.UPDATE_NODE, id, patch),
  deleteNode: (id: string): Promise<boolean> => call(IPC.DELETE_NODE, id),
  moveNode: (id: string, delta: -1 | 1): Promise<boolean> => call(IPC.MOVE_NODE, id, delta),
  reorderNodes: (ids: string[]): Promise<boolean> => call(IPC.REORDER_NODES, ids),

  // ---- 并行分支 ----
  listBranches: (wfId: string): Promise<BranchItem[]> => call(IPC.LIST_BRANCHES, wfId),
  createBranches: (wfId: string, forkNodeId: string, names: string[], rootTitle?: string): Promise<{ branches: BranchItem[]; roots: NodeItem[] }> =>
    call(IPC.CREATE_BRANCHES, wfId, forkNodeId, names, rootTitle),
  renameBranch: (branchId: string, name: string): Promise<boolean> => call(IPC.RENAME_BRANCH, branchId, name),
  deleteBranch: (branchId: string, confirmedCascade?: boolean): Promise<{ removedNodes: number }> =>
    call(IPC.DELETE_BRANCH, branchId, !!confirmedCascade),
  setBranchStatus: (branchId: string, status: 'active' | 'done'): Promise<BranchItem> => call(IPC.SET_BRANCH_STATUS, branchId, status),
  appendToBranch: (branchId: string, title: string): Promise<NodeItem> => call(IPC.APPEND_TO_BRANCH, branchId, title),
  gatingInfo: (wfId: string): Promise<{ blocked: boolean; blockers: { forkNodeId: string; forkTitle: string; unfinished: { id: string; name: string }[] }[] }> =>
    call(IPC.GATING_INFO, wfId),

  // ---- 附件 ----
  listAttachments: (nodeId: string): Promise<Attachment[]> => call(IPC.LIST_ATTACHMENTS, nodeId),
  importAttachments: (nodeId: string, srcPaths: string[]): Promise<{ imported: number; skipped: { name: string; reason: string }[] }> => call(IPC.IMPORT_ATTACHMENTS, nodeId, srcPaths),
  cancelImport: (): Promise<boolean> => call(IPC.CANCEL_IMPORT),
  openAttachment: (attId: string): Promise<boolean> => call(IPC.OPEN_ATTACHMENT, attId),
  showInFolder: (attId: string): Promise<boolean> => call(IPC.SHOW_IN_FOLDER, attId),
  renameAttachment: (attId: string, newName: string): Promise<boolean> => call(IPC.RENAME_ATTACHMENT, attId, newName),
  removeAttachment: (attId: string): Promise<boolean> => call(IPC.REMOVE_ATTACHMENT, attId),

  // ---- 搜索 ----
  search: (kw: string): Promise<SearchHit[]> => call(IPC.SEARCH, kw),

  // ---- 回收站 ----
  listRecycle: (): Promise<RecycleItem[]> => call(IPC.RECYCLE_LIST),
  restoreItem: (kind: 'workflow' | 'node' | 'branch' | 'attachment', id: string): Promise<boolean> => call(IPC.RECYCLE_RESTORE, kind, id),
  purgeItem: (kind: 'workflow' | 'node' | 'branch' | 'attachment', id: string): Promise<boolean> => call(IPC.RECYCLE_PURGE, kind, id),
  emptyRecycle: (): Promise<boolean> => call(IPC.RECYCLE_EMPTY),

  // ---- 导出导入 ----
  exportWorkflow: (wfId: string): Promise<string> => call(IPC.EXPORT_WORKFLOW, wfId),
  importWorkflow: (zipPath: string): Promise<{ workflow_id: string; workflow_name: string }> => call(IPC.IMPORT_WORKFLOW, zipPath),

  // ---- 备份 ----
  backupNow: (): Promise<string> => call(IPC.BACKUP_NOW),
  listBackups: (): Promise<{ name: string; size: number; mtime: string }[]> => call(IPC.GET_BACKUPS),

  // ---- 设置 ----
  changeDataDir: (dir: string, moveData: boolean): Promise<string> => call(IPC.CHANGE_DATA_DIR, dir, moveData),

  // ---- 日志 ----
  appLog: (level: 'info' | 'warn' | 'error', msg: string): Promise<boolean> => call(IPC.LOG, level, msg),

  // ---- 事件订阅（主进程推送） ----
  onImportProgress: (cb: (p: ImportProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: ImportProgress): void => cb(p);
    ipcRenderer.on(IPC.ATT_IMPORT_PROGRESS, listener);
    return () => ipcRenderer.removeListener(IPC.ATT_IMPORT_PROGRESS, listener);
  },
  onPrepareClose: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC.PREPARE_CLOSE, listener);
    return () => ipcRenderer.removeListener(IPC.PREPARE_CLOSE, listener);
  }
};

contextBridge.exposeInMainWorld('helpwork', api);

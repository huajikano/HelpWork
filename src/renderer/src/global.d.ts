// 渲染进程全局类型：window.helpwork 由 preload 注入
import type { Workflow, NodeItem, Attachment, SearchHit, RecycleItem, DiskUsage, ImportProgress, BranchItem } from '../../shared/types';

export interface HelpworkApi {
  init: () => Promise<{ dataDir: string }>;
  recoverChoose: () => Promise<string>;
  recoverDefault: () => Promise<string>;
  getAppInfo: () => Promise<{ version: string; electron: string; node: string }>;
  getDataDir: () => Promise<string>;
  getDiskUsage: () => Promise<DiskUsage>;
  openPath: (p: string) => Promise<boolean>;
  openInFolder: (p: string) => Promise<boolean>;
  chooseFiles: () => Promise<string[]>;
  chooseImportZip: () => Promise<string | null>;
  selectDirectory: () => Promise<string>;
  pathForFile: (file: File) => Promise<string>;
  flushNote: () => Promise<boolean>;

  listWorkflows: () => Promise<Workflow[]>;
  createWorkflow: (name: string) => Promise<Workflow>;
  renameWorkflow: (id: string, name: string) => Promise<boolean>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  reorderWorkflows: (ids: string[]) => Promise<boolean>;

  listNodes: (wfId: string) => Promise<NodeItem[]>;
  createNode: (wfId: string, title: string, opts?: { parentId?: string | null; branchId?: string | null }) => Promise<NodeItem>;
  updateNode: (id: string, patch: { title?: string; note?: string }) => Promise<boolean>;
  deleteNode: (id: string) => Promise<boolean>;
  moveNode: (id: string, delta: -1 | 1) => Promise<boolean>;
  reorderNodes: (ids: string[]) => Promise<boolean>;

  listBranches: (wfId: string) => Promise<BranchItem[]>;
  createBranches: (wfId: string, forkNodeId: string, names: string[], rootTitle?: string) => Promise<{ branches: BranchItem[]; roots: NodeItem[] }>;
  renameBranch: (branchId: string, name: string) => Promise<boolean>;
  deleteBranch: (branchId: string, confirmedCascade?: boolean) => Promise<{ removedNodes: number }>;
  setBranchStatus: (branchId: string, status: 'active' | 'done') => Promise<BranchItem>;
  appendToBranch: (branchId: string, title: string) => Promise<NodeItem>;
  gatingInfo: (wfId: string) => Promise<{ blocked: boolean; blockers: { forkNodeId: string; forkTitle: string; unfinished: { id: string; name: string }[] }[] }>;

  listAttachments: (nodeId: string) => Promise<Attachment[]>;
  importAttachments: (nodeId: string, srcPaths: string[]) => Promise<{ imported: number; skipped: { name: string; reason: string }[] }>;
  cancelImport: () => Promise<boolean>;
  openAttachment: (attId: string) => Promise<boolean>;
  showInFolder: (attId: string) => Promise<boolean>;
  renameAttachment: (attId: string, newName: string) => Promise<boolean>;
  removeAttachment: (attId: string) => Promise<boolean>;

  search: (kw: string) => Promise<SearchHit[]>;
  listRecycle: () => Promise<RecycleItem[]>;
  restoreItem: (kind: 'workflow' | 'node' | 'branch' | 'attachment', id: string) => Promise<boolean>;
  purgeItem: (kind: 'workflow' | 'node' | 'branch' | 'attachment', id: string) => Promise<boolean>;
  emptyRecycle: () => Promise<boolean>;

  exportWorkflow: (wfId: string) => Promise<string>;
  importWorkflow: (zipPath: string) => Promise<{ workflow_id: string; workflow_name: string }>;
  backupNow: () => Promise<string>;
  listBackups: () => Promise<{ name: string; size: number; mtime: string }[]>;
  changeDataDir: (dir: string, moveData: boolean) => Promise<string>;
  appLog: (level: 'info' | 'warn' | 'error', msg: string) => Promise<boolean>;
  onImportProgress: (cb: (p: ImportProgress) => void) => () => void;
  onPrepareClose: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    helpwork: HelpworkApi;
  }
}

export {};

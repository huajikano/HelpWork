// 共享类型定义（主进程与渲染进程共用）

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  node_count?: number; // 列表查询时附带
  /** 未识别 JSON 字段的透传袋 */
  extra_json?: string | null;
}

export interface NodeItem {
  id: string;
  workflow_id: string;
  title: string;
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // ---- v2 并行分支字段 ----
  /** 所属分叉点的节点 id；主线节点为 null */
  parent_id: string | null;
  /** 所属并行分支 id；主线节点为 null */
  branch_id: string | null;
  attachment_count?: number; // 列表查询时附带
  /** 未识别 JSON 字段的透传袋 */
  extra_json?: string | null;
}

/** 并行分支（v2） */
export interface BranchItem {
  id: string;
  workflow_id: string;
  /** 分叉点节点 id（该分支从这个节点派生） */
  fork_node_id: string;
  name: string;
  /** 显式完成标记：active=进行中，done=已完成 */
  status: 'active' | 'done';
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 未识别 JSON 字段的透传袋 */
  extra_json?: string | null;
}

export interface Attachment {
  id: string;
  node_id: string;
  sha256: string;
  original_name: string;
  stored_path: string;
  size: number;
  ext: string | null;
  created_at: string;
  deleted_at: string | null;
  /** 未识别 JSON 字段的透传袋 */
  extra_json?: string | null;
}

export interface SearchHit {
  workflow_id: string;
  workflow_name: string;
  node_id: string;
  node_title: string;
  match_type: 'title' | 'note' | 'attachment';
  match_text: string; // 命中片段
}

export interface RecycleItem {
  kind: 'workflow' | 'node' | 'branch' | 'attachment';
  id: string;
  name: string;
  parent_id: string | null;
  deleted_at: string;
}

export interface ImportProgress {
  stage: string; // 中文进度说明
  percent: number; // 0-100，-1 表示不确定
}

export interface ImportResult {
  ok: boolean;
  message: string;
  workflow_id?: string;
  workflow_name?: string;
}

export interface DiskUsage {
  files_bytes: number;
  files_count: number;
  db_bytes: number;
  backups_bytes: number;
}

export interface AppConfig {
  dataDir: string;
}

export const SCHEMA_VERSION = 2;

// IPC 通道名集中定义，避免字符串散落
export const IPC = {
  // 应用
  INIT: 'app:init',
  RECOVER_CHOOSE: 'app:recover-choose-dir',
  RECOVER_DEFAULT: 'app:recover-use-default',
  GET_APP_INFO: 'app:get-info',
  GET_DATA_DIR: 'app:get-data-dir',
  GET_DISK_USAGE: 'app:get-disk-usage',
  OPEN_PATH: 'app:open-path',
  OPEN_IN_FOLDER: 'app:open-in-folder',
  CHOOSE_FILES: 'app:choose-files',
  CHOOSE_IMPORT_ZIP: 'app:choose-import-zip',
  SELECT_DIRECTORY: 'app:select-directory',
  // 流程
  LIST_WORKFLOWS: 'wf:list',
  CREATE_WORKFLOW: 'wf:create',
  RENAME_WORKFLOW: 'wf:rename',
  DELETE_WORKFLOW: 'wf:delete',
  REORDER_WORKFLOWS: 'wf:reorder',
  // 节点
  LIST_NODES: 'node:list',
  CREATE_NODE: 'node:create',
  UPDATE_NODE: 'node:update',
  DELETE_NODE: 'node:delete',
  MOVE_NODE: 'node:move',
  REORDER_NODES: 'node:reorder',
  // 并行分支
  LIST_BRANCHES: 'branch:list',
  CREATE_BRANCHES: 'branch:create-many',
  RENAME_BRANCH: 'branch:rename',
  DELETE_BRANCH: 'branch:delete',
  SET_BRANCH_STATUS: 'branch:set-status',
  APPEND_TO_BRANCH: 'branch:append-node',
  GATING_INFO: 'branch:gating-info',
  // 附件
  LIST_ATTACHMENTS: 'att:list',
  IMPORT_ATTACHMENTS: 'att:import',
  CANCEL_IMPORT: 'att:cancel-import',
  ATT_IMPORT_PROGRESS: 'ev:att-import-progress', // 主进程→渲染进程 推送
  FLUSH_NOTE: 'app:flush-note', // 关窗前同步落盘备注
  PREPARE_CLOSE: 'ev:prepare-close', // 主进程→渲染进程：窗口即将关闭，请立即保存
  OPEN_ATTACHMENT: 'att:open',
  SHOW_IN_FOLDER: 'att:show-in-folder',
  RENAME_ATTACHMENT: 'att:rename',
  REMOVE_ATTACHMENT: 'att:remove',
  // 搜索
  SEARCH: 'search:run',
  // 回收站
  RECYCLE_LIST: 'recycle:list',
  RECYCLE_RESTORE: 'recycle:restore',
  RECYCLE_PURGE: 'recycle:purge',
  RECYCLE_EMPTY: 'recycle:empty',
  // 导出导入
  EXPORT_WORKFLOW: 'io:export-workflow',
  IMPORT_WORKFLOW: 'io:import-workflow',
  // 备份
  BACKUP_NOW: 'backup:now',
  GET_BACKUPS: 'backup:list',
  // 设置
  CHANGE_DATA_DIR: 'settings:change-data-dir',
  // 日志
  LOG: 'log:write'
} as const;

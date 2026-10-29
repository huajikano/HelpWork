// 导出/导入 zip 的数据格式定义（与 workflow.json 对应）
// v1：线性节点列表；v2：节点含分支字段 + branches 数组（并行分支）

export interface ExportAttachmentInfo {
  id: string;
  sha256: string;
  original_name: string;
  stored_path: string;
  size: number;
  ext: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface ExportNodeInfo {
  id: string;
  title: string;
  note: string | null;
  sort_order: number;
  parent_id?: string | null;
  branch_id?: string | null;
  attachments: ExportAttachmentInfo[];
  [key: string]: unknown;
}

export interface ExportBranchInfo {
  id: string;
  fork_node_id: string;
  name: string;
  status: 'active' | 'done';
  completed_at: string | null;
  sort_order: number;
  [key: string]: unknown;
}

export interface ExportPayload {
  format: 'helpwork-workflow';
  /** 1 = 线性；2 = 含并行分支 */
  version: 1 | 2;
  exported_at: string;
  workflow: { id: string; name: string; description: string | null; [key: string]: unknown };
  nodes: ExportNodeInfo[];
  /** v2 专用；v1 包无此字段 */
  branches?: ExportBranchInfo[];
  [key: string]: unknown;
}

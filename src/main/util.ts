// 通用工具：长路径、时间、大小格式化等
import * as path from 'node:path';

/** 为文件系统操作加 \\?\ 长路径前缀（兼容超长路径；对非绝对路径原样返回） */
export function lp(p: string): string {
  if (!p) return p;
  if (p.startsWith('\\\\?\\')) return p;
  if (/^[a-zA-Z]:\\/.test(p)) return `\\\\?\\${p}`;
  if (p.startsWith('\\\\')) return `\\\\?\\UNC\\${p.slice(2)}`;
  return p;
}

/** 去掉 \\?\ 前缀（用于展示） */
export function unlp(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/** 规范化分隔符为 \\ */
export function norm(p: string): string {
  return p.replace(/\//g, '\\');
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** 字节数 → 中文可读大小 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 文件名安全化：去除路径分隔符与非法字符，保留中文 */
export function sanitizeFileName(name: string): string {
  const base = path.basename(name.replace(/[\\/]+/g, '_'));
  return base.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim() || '未命名文件';
}

/** 中文可读错误信息：把系统异常转成友好提示 */
export function friendlyError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = String((err as { message: unknown }).message);
    // 常见系统错误转译
    if (/ENOENT/i.test(m)) return `${fallback}：找不到文件或目录`;
    if (/EPERM|EACCES/i.test(m)) return `${fallback}：没有访问权限`;
    if (/ENOSPC/i.test(m)) return `${fallback}：磁盘空间不足`;
    if (/EBUSY/i.test(m)) return `${fallback}：文件正被其他程序占用`;
    return `${fallback}：${m}`;
  }
  if (typeof err === 'string' && err) return `${fallback}：${err}`;
  return fallback;
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

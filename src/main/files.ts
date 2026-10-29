// 附件实体文件管理：files\<sha256 前2位>\<sha256>_<原始文件名>
// 按内容哈希去重；大文件异步复制 + 进度 + 可取消
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lp, norm, sanitizeFileName, delay } from './util';
import { log } from './logger';
import { getDb } from './db';

export function filesRoot(dataDir: string): string {
  return path.join(dataDir, 'files');
}

export function backupsDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

export function tmpDir(dataDir: string): string {
  return path.join(filesRoot(dataDir), 'tmp');
}

export function ensureDirs(dataDir: string): void {
  for (const d of [dataDir, filesRoot(dataDir), tmpDir(dataDir), backupsDir(dataDir), path.join(dataDir, 'logs')]) {
    fs.mkdirSync(lp(d), { recursive: true });
  }
}

export interface StoredFile {
  sha256: string;
  stored_path: string; // 相对 files\ 的路径
  size: number;
}

/** 计算文件 SHA256（流式，避免大文件占内存） */
export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = fs.createReadStream(lp(absPath), { highWaterMark: 1024 * 1024 });
    stream.on('data', (c) => h.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

/** 目标实体文件名：<sha256>_<安全化的原始名> */
export function entityFileName(sha256: string, originalName: string): string {
  return `${sha256}_${sanitizeFileName(originalName)}`;
}

/** 同哈希是否已有其他未删除附件引用 */
export function shaInUse(sha256: string, excludeAttId?: string): boolean {
  const d = getDb();
  if (excludeAttId) {
    const row = d
      .prepare('SELECT COUNT(*) AS c FROM attachment WHERE sha256 = ? AND id != ? AND deleted_at IS NULL')
      .get(sha256, excludeAttId) as { c: number };
    return row.c > 0;
  }
  const row = d.prepare('SELECT COUNT(*) AS c FROM attachment WHERE sha256 = ? AND deleted_at IS NULL').get(sha256) as {
    c: number;
  };
  return row.c > 0;
}

/** 同哈希是否存在任何附件行（含软删除，用于复用实体文件路径） */
export function shaAnyRow(sha256: string): { stored_path: string } | undefined {
  return getDb().prepare('SELECT stored_path FROM attachment WHERE sha256 = ? LIMIT 1').get(sha256) as
    | { stored_path: string }
    | undefined;
}

/** 若实体文件已无任何引用（含回收站中的行），删除实体文件 */
export function removeEntityIfUnreferenced(dataDir: string, sha256: string): void {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM attachment WHERE sha256 = ?').get(sha256) as { c: number };
  if (row.c > 0) return; // 仍有行引用（含软删除），保留实体
  // 兜底：扫描 files\<前2位>\ 目录中以 <sha256>_ 开头的文件
  const dir = path.join(filesRoot(dataDir), sha256.slice(0, 2));
  try {
    if (!fs.existsSync(lp(dir))) return;
    for (const name of fs.readdirSync(lp(dir))) {
      if (name.startsWith(`${sha256}_`)) {
        fs.rmSync(lp(path.join(dir, name)), { force: true });
        log.info(`清理无引用实体：${sha256.slice(0, 12)}…`);
      }
    }
  } catch (e) {
    log.warn(`清理实体失败（sha=${sha256.slice(0, 12)}…）：${(e as Error).message}`);
  }
}

/**
 * 复制进实体仓库（若同哈希实体已存在则直接复用，秒完成）。
 * 异步分块复制 + 进度回调（节流 100ms）+ 取消。
 */
export async function storeFile(
  dataDir: string,
  srcAbsPath: string,
  originalName: string,
  opts?: { onProgress?: (copied: number, total: number) => void; isCancelled?: () => boolean }
): Promise<StoredFile> {
  const st = fs.statSync(lp(srcAbsPath));
  const total = st.size;

  // 第一步：哈希（进度按 0~40% 折算）
  let hashDone = 0;
  const sha = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    const stream = fs.createReadStream(lp(srcAbsPath), { highWaterMark: 1024 * 1024 });
    stream.on('data', (c) => {
      h.update(c);
      hashDone += c.length;
      if (total > 0) opts?.onProgress?.(Math.floor((hashDone / total) * 40), total);
      if (opts?.isCancelled?.()) {
        stream.destroy();
        reject(new Error('CANCELLED'));
      }
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });

  // 去重：同哈希实体文件已存在（文件系统级判断）则直接复用；
  // 数据库行查不到也要复用——否则同内容文件在无附件行时会重复占空间
  const existing = shaAnyRow(sha);
  if (existing) {
    const absExisting = path.join(filesRoot(dataDir), norm(existing.stored_path));
    if (fs.existsSync(lp(absExisting))) {
      opts?.onProgress?.(total, total);
      log.info(`附件去重复用（按库）：${originalName}（${sha.slice(0, 12)}…）`);
      return { sha256: sha, stored_path: existing.stored_path, size: total };
    }
  }
  const subdir = sha.slice(0, 2);
  const destDir = path.join(filesRoot(dataDir), subdir);
  fs.mkdirSync(lp(destDir), { recursive: true });
  const destName = entityFileName(sha, originalName);
  const destAbs = path.join(destDir, destName);
  if (fs.existsSync(lp(destAbs))) {
    opts?.onProgress?.(total, total);
    log.info(`附件去重复用（按文件）：${originalName}（${sha.slice(0, 12)}…）`);
    return { sha256: sha, stored_path: path.join(subdir, destName), size: total };
  }
  // 同哈希但文件名不同（原始名不一样）：目录里可能已有 <sha>_其他名，一并复用
  try {
    const sameSha = fs.readdirSync(lp(destDir)).find((n) => n.startsWith(`${sha}_`));
    if (sameSha) {
      opts?.onProgress?.(total, total);
      log.info(`附件去重复用（同哈希异名）：${originalName} → ${sameSha}`);
      return { sha256: sha, stored_path: path.join(subdir, sameSha), size: total };
    }
  } catch {
    /* 目录不可读时按正常复制走 */
  }

  // 第二步：分块复制（进度按 40~100% 折算）
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (err) {
        try {
          fs.rmSync(lp(destAbs), { force: true }); // 失败/取消时清理半成品
        } catch {
          /* 忽略 */
        }
        reject(err);
      } else {
        resolve();
      }
    };
    let copied = 0;
    let lastReported = -1;
    const timer = setInterval(() => {
      const pct = 40 + Math.floor(total > 0 ? (copied / total) * 60 : 100);
      if (pct !== lastReported) {
        lastReported = pct;
        opts?.onProgress?.(pct, total);
      }
    }, 100);

    const src = fs.createReadStream(lp(srcAbsPath), { highWaterMark: 4 * 1024 * 1024 });
    const dst = fs.createWriteStream(lp(destAbs));
    src.on('data', (chunk: unknown) => {
      copied += (chunk as Buffer).length;
      if (opts?.isCancelled?.()) {
        src.destroy();
        dst.destroy();
        done(new Error('CANCELLED'));
      }
    });
    src.on('error', (e) => done(e));
    dst.on('error', (e) => done(e));
    dst.on('finish', () => done());
    src.pipe(dst);
  });

  log.info(`附件入库：${originalName}（${sha.slice(0, 12)}…，${total} 字节）`);
  return { sha256: sha, stored_path: path.join(subdir, destName), size: total };
}

/** 附件实体的绝对路径 */
export function entityAbsPath(dataDir: string, storedPath: string): string {
  return path.join(filesRoot(dataDir), norm(storedPath));
}

/** 数据目录占用统计 */
export function diskUsage(dataDir: string): {
  files_bytes: number;
  files_count: number;
  db_bytes: number;
  backups_bytes: number;
} {
  const sum = (dir: string): { bytes: number; count: number } => {
    let bytes = 0;
    let count = 0;
    const walk = (d: string): void => {
      try {
        for (const e of fs.readdirSync(lp(d), { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            if (e.name === 'tmp') continue; // 中转目录不计
            walk(p);
          } else if (e.isFile()) {
            const s = fs.statSync(lp(p));
            bytes += s.size;
            count += 1;
          }
        }
      } catch {
        /* 目录不可访问时跳过 */
      }
    };
    walk(dir);
    return { bytes, count };
  };

  const files = sum(filesRoot(dataDir));
  const dbb = (() => {
    try {
      const p = path.join(dataDir, 'helpwork.db');
      let s = fs.statSync(lp(p)).size;
      const wal = p + '-wal';
      if (fs.existsSync(lp(wal))) s += fs.statSync(lp(wal)).size;
      const shm = p + '-shm';
      if (fs.existsSync(lp(shm))) s += fs.statSync(lp(shm)).size;
      return s;
    } catch {
      return 0;
    }
  })();
  const backups = sum(backupsDir(dataDir));
  return { files_bytes: files.bytes, files_count: files.count, db_bytes: dbb, backups_bytes: backups.bytes };
}

/** 清理 tmp 中转目录 */
export async function cleanTmp(dataDir: string): Promise<void> {
  const t = tmpDir(dataDir);
  try {
    if (!fs.existsSync(lp(t))) return;
    for (const name of fs.readdirSync(lp(t))) {
      fs.rmSync(lp(path.join(t, name)), { force: true, recursive: true });
    }
  } catch {
    /* 忽略 */
  }
  await delay(0);
}

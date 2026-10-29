// 备份：helpwork.db + files\ 打包为时间戳 zip，保留最近 7 份
// 同时也是「导出单流程 zip」的底层实现（选择性打包）
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lp } from './util';
import { log } from './logger';
import { backupsDir, filesRoot } from './files';

const KEEP = 7;

export function timestampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

/** 全量备份：db + 全部实体文件（WAL 已在打包前 checkpoint） */
export function createBackup(dataDir: string, dbFile: string): string {
  const zip = new AdmZip();
  zip.addFile('helpwork.db', fs.readFileSync(lp(dbFile)));
  const root = filesRoot(dataDir);
  const addDir = (absDir: string, relDir: string): void => {
    try {
      for (const e of fs.readdirSync(lp(absDir), { withFileTypes: true })) {
        if (e.name === 'tmp') continue;
        const abs = path.join(absDir, e.name);
        const rel = relDir ? path.join(relDir, e.name) : e.name;
        if (e.isDirectory()) addDir(abs, rel);
        else if (e.isFile()) zip.addFile(normJoin('files', rel), fs.readFileSync(lp(abs)));
      }
    } catch {
      /* 跳过不可访问项 */
    }
  };
  addDir(root, '');

  const dir = backupsDir(dataDir);
  fs.mkdirSync(lp(dir), { recursive: true });
  const out = path.join(dir, timestampName());
  zip.writeZip(lp(out));
  log.info(`备份完成：${out}（${fs.statSync(lp(out)).size} 字节）`);
  pruneBackups(dir);
  return out;
}

function normJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/');
}

export function listBackups(dataDir: string): { name: string; size: number; mtime: string }[] {
  const dir = backupsDir(dataDir);
  try {
    return fs
      .readdirSync(lp(dir))
      .filter((n) => n.endsWith('.zip'))
      .map((n) => {
        const st = fs.statSync(lp(path.join(dir, n)));
        return { name: n, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

function pruneBackups(dir: string): void {
  try {
    const list = fs
      .readdirSync(lp(dir))
      .filter((n) => n.startsWith('backup_') && n.endsWith('.zip'))
      .sort(); // 时间戳名字典序即时间序
    while (list.length > KEEP) {
      fs.rmSync(lp(path.join(dir, list.shift()!)), { force: true });
      log.info(`备份轮换：删除旧备份，保留最近 ${KEEP} 份`);
    }
  } catch {
    /* 忽略 */
  }
}

/** 每日自动备份：一天最多一次（meta 记录日期） */
export function needAutoBackup(getMeta: (k: string) => string | undefined, setMeta: (k: string, v: string) => void): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const last = getMeta('last_auto_backup_date');
  if (last === today) return false;
  setMeta('last_auto_backup_date', today);
  return true;
}

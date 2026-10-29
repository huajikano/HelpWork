// 数据库层：node:sqlite（Electron 36 内嵌 Node 22，内置模块，免原生编译）
// 落盘为数据目录下单一 helpwork.db，WAL 模式
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../shared/types';
import { lp } from './util';
import { log } from './logger';

let db: DatabaseSync | null = null;

export function dbPath(dataDir: string): string {
  return path.join(dataDir, 'helpwork.db');
}

/** 若检测到旧版数据库，则在任何建表/ALTER 写入之前 checkpoint 并备份原库。 */
function backupBeforeUpgrade(d: DatabaseSync, dataDir: string, file: string): void {
  if (!fs.existsSync(lp(file)) || fs.statSync(lp(file)).size === 0) return;
  try {
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[];
    const tableSet = new Set(tables.map((t) => t.name));
    if (tableSet.size === 0) return; // 空的新 SQLite 文件，没有旧数据需要备份
    const cols = (table: string): string[] => (d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
    // 有任何旧核心表/字段缺失均先备份；空的新库文件在上方已跳过。
    const needsUpgrade = !tableSet.has('workflow') || !tableSet.has('node') || !tableSet.has('branch') ||
      !cols('node').includes('parent_id') || !cols('node').includes('branch_id') ||
      !cols('workflow').includes('extra_json') || !cols('node').includes('extra_json') || !cols('branch').includes('extra_json') || !cols('attachment').includes('extra_json');
    if (!needsUpgrade) return;
    d.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const versionRow = tableSet.has('meta')
      ? (d.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined)
      : undefined;
    const ver = versionRow?.value ? Number(versionRow.value) : 1;
    const dest = preMigrationBackupPath(dataDir, Number.isFinite(ver) ? ver : 1);
    fs.mkdirSync(lp(path.dirname(dest)), { recursive: true });
    fs.copyFileSync(lp(file), lp(dest));
    log.info(`数据库写入升级前已自动备份：${dest}`);
  } catch (e) {
    // 用户数据安全优先：备份失败即阻止升级，避免在无可回滚副本时改写原库。
    throw new Error(`迁移前数据库备份失败，已取消升级以保护原数据：${(e as Error).message}`);
  }
}

/** 迁移前备份文件路径（带时间戳，避免覆盖） */
function preMigrationBackupPath(dataDir: string, fromVer: number): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return path.join(dataDir, 'backups', `pre_migration_v${fromVer}_to_v${SCHEMA_VERSION}_${stamp}.db`);
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

/** 打开（或创建）数据库并建表/迁移。失败抛出异常（中文信息由调用方包装）。 */
export function openDb(dataDir: string): void {
  if (db) {
    db.close();
    db = null;
  }
  fs.mkdirSync(lp(dataDir), { recursive: true });
  const file = dbPath(dataDir);
  db = new DatabaseSync(lp(file));
  backupBeforeUpgrade(db, dataDir, file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, dataDir, file);
  log.info(`数据库已打开：${file}（schema v${getVersion()}）`);
}

export function closeDb(): void {
  if (db) {
    try {
      // 关库前 checkpoint，尽量把 WAL 合并进主库文件，便于整体拷贝迁移
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* 忽略 */
    }
    db.close();
    db = null;
  }
}

function getVersion(): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function migrate(d: DatabaseSync, dataDir: string, file: string): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      extra_json  TEXT
    );

    CREATE TABLE IF NOT EXISTS node (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      note        TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      parent_id   TEXT,
      branch_id   TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      extra_json  TEXT
    );

    CREATE TABLE IF NOT EXISTS attachment (
      id            TEXT PRIMARY KEY,
      node_id       TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
      sha256        TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_path   TEXT NOT NULL,
      size          INTEGER NOT NULL DEFAULT 0,
      ext           TEXT,
      created_at    TEXT NOT NULL,
      deleted_at    TEXT,
      extra_json    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_node_wf      ON node(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_att_node     ON attachment(node_id);
    CREATE INDEX IF NOT EXISTS idx_att_sha      ON attachment(sha256);
    CREATE INDEX IF NOT EXISTS idx_wf_deleted   ON workflow(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_node_deleted ON node(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_att_deleted  ON attachment(deleted_at);
  `);

  const cur = (() => {
    const row = d.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  })();

  if (cur < 1) {
    d.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION));
    log.info('数据库初始化：schema v1 已写入');
  }

  // ---- 迁移逻辑（v1 → v2）在 migrateV2 中执行 ----
  migrateV2(d, dataDir, file, cur);
  // JSON 扩展袋保留导入包/后续版本的未知字段，旧库首次写入前已于 openDb 中备份。
  ensureColumn(d, 'workflow', 'extra_json', 'extra_json TEXT');
  ensureColumn(d, 'node', 'extra_json', 'extra_json TEXT');
  ensureColumn(d, 'branch', 'extra_json', 'extra_json TEXT');
  ensureColumn(d, 'attachment', 'extra_json', 'extra_json TEXT');

  // 尝试创建 FTS5 全文索引（可用则保留作扩展能力；实际搜索走 LIKE，中文子串等价）
  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_search USING fts5(
        node_title, node_note, att_name
      );
    `);
    log.info('FTS5 可用，已创建全文索引表（当前搜索使用 LIKE，中文子串更友好）');
  } catch {
    log.info('FTS5 不可用，搜索将退化为 LIKE 查询（效果等价）');
  }
}

/** 事务包装：所有写库操作都必须放在事务中 */
export function withTx<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* 忽略回滚失败 */
    }
    throw e;
  }
}

/** 数据库是否已初始化 */
export function isDbReady(): boolean {
  return db !== null;
}

/** v1 → v2 迁移：并行分支（迁移前备份原库 + branch 表 + node 补列） */
function ensureColumn(d: DatabaseSync, table: string, name: string, ddl: string): void {
  const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
  if (!cols.includes(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function migrateV2(d: DatabaseSync, _dataDir: string, _file: string, cur: number): void {
  if (cur < 2) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS branch (
        id           TEXT PRIMARY KEY,
        workflow_id  TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
        fork_node_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
        completed_at TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT,
        extra_json   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_branch_wf   ON branch(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_branch_fork ON branch(fork_node_id);
    `);
    // 旧库的 node 表补两列（新库由 CREATE TABLE 直接含列，此处幂等）
    const cols = (d.prepare('PRAGMA table_info(node)').all() as unknown as { name: string }[]).map((c) => c.name);
    if (!cols.includes('parent_id')) {
      d.exec('ALTER TABLE node ADD COLUMN parent_id TEXT');
      log.info('node 表新增列 parent_id（v2 并行分支）');
    }
    if (!cols.includes('branch_id')) {
      d.exec('ALTER TABLE node ADD COLUMN branch_id TEXT');
      log.info('node 表新增列 branch_id（v2 并行分支）');
    }
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_node_branch ON node(branch_id);
      CREATE INDEX IF NOT EXISTS idx_node_parent ON node(parent_id);
    `);
    d.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', '2');
    log.info('数据库已迁移：schema v2（并行分支）');
  }
}

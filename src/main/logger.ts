// 本地日志：HelpWorkData\logs\app.log，超 2MB 滚动，保留 3 份
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const KEEP_COUNT = 3;

let logDir = '';
let logFile = '';

export function initLogger(dir: string): void {
  try {
    logDir = dir;
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'app.log');
  } catch {
    // 日志初始化失败不应影响主流程
  }
}

function rollIfNeeded(): void {
  try {
    if (!logFile || !fs.existsSync(logFile)) return;
    const st = fs.statSync(logFile);
    if (st.size < MAX_LOG_BYTES) return;
    // app.log.2 -> 删除；app.log.1 -> .2；app.log -> .1
    const oldest = path.join(logDir, `app.log.${KEEP_COUNT - 1}`);
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = KEEP_COUNT - 2; i >= 0; i--) {
      const src = path.join(logDir, i === 0 ? 'app.log' : `app.log.${i}`);
      const dst = path.join(logDir, `app.log.${i + 1}`);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
  } catch {
    /* 忽略滚动失败 */
  }
}

type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, msg: string): void {
  if (!logFile) return;
  try {
    rollIfNeeded();
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* 忽略写入失败 */
  }
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg)
};

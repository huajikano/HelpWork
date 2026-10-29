// 应用配置：%APPDATA%\HelpWork\config.json —— 记录当前数据目录
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { lp } from './util';
import { log } from './logger';

export interface Config {
  dataDir: string;
}

function configDir(): string {
  return path.join(app.getPath('appData'), 'HelpWork');
}

function configFile(): string {
  return path.join(configDir(), 'config.json');
}

/** 默认数据目录：exe 所在目录下 HelpWorkData\（绿色版便携） */
export function defaultDataDir(): string {
  // app.getAppPath()：打包后指向 exe 所在目录的 app.asar；开发期指向工程根
  let base: string;
  if (app.isPackaged) {
    base = path.dirname(app.getPath('exe'));
  } else {
    base = app.getAppPath();
  }
  return path.join(base, 'HelpWorkData');
}

export function readConfig(): Config {
  try {
    const raw = fs.readFileSync(lp(configFile()), 'utf8');
    const obj = JSON.parse(raw) as Partial<Config>;
    if (obj && typeof obj.dataDir === 'string' && obj.dataDir) {
      return { dataDir: obj.dataDir };
    }
  } catch {
    /* 首次运行无配置文件，走默认 */
  }
  return { dataDir: defaultDataDir() };
}

export function writeConfig(cfg: Config): void {
  fs.mkdirSync(lp(configDir()), { recursive: true });
  fs.writeFileSync(lp(configFile()), JSON.stringify(cfg, null, 2), 'utf8');
  log.info(`配置已写入：${cfg.dataDir}`);
}

/** 数据目录是否可用（存在或可创建，且可写） */
export function checkDataDirUsable(dir: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(lp(dir), { recursive: true });
    const probe = path.join(dir, `.probe_${Date.now()}`);
    fs.writeFileSync(lp(probe), 'ok', 'utf8');
    fs.rmSync(lp(probe), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

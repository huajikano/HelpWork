// HelpWork 主进程入口
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { initLogger, log } from './logger';
import { readConfig, checkDataDirUsable } from './config';
import { ensureDirs } from './files';
import { openDb, closeDb, isDbReady, dbPath } from './db';
import { setDataDir, setInitError, getInitError, tryGetDataDir } from './runtime';
import { registerIpc } from './ipc';
import { needAutoBackup, createBackup } from './backup';
import { getMeta, setMeta } from './services';

let mainWindow: BrowserWindow | null = null;

function initDataDir(): boolean {
  const dir = readConfig().dataDir;
  const usable = checkDataDirUsable(dir);
  if (!usable.ok) {
    initLogger(path.join(app.getPath('temp'), 'helpwork-error'));
    log.error(`数据目录不可用：${dir} ${usable.error ?? ''}`);
    setInitError(`数据目录不可用：${dir}`);
    return false;
  }
  try {
    ensureDirs(dir);
    initLogger(path.join(dir, 'logs'));
    openDb(dir);
    setDataDir(dir);
    setInitError(null);
    log.info(`HelpWork 启动，数据目录：${dir}`);
    return true;
  } catch (e) {
    log.error(`数据目录初始化失败：${(e as Error).message}`);
    setInitError(`数据目录初始化失败：${(e as Error).message}`);
    return false;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'HelpWork 工作流档案柜',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 关窗前给渲染进程一个保存备注的机会（防抖中的备注立即落盘）
  mainWindow.on('close', (e) => {
    const win = mainWindow;
    if (!win) return;
    if (win.webContents.isLoading()) return; // 页面尚未加载完，直接关
    if ((win as unknown as { _hwClosing?: boolean })._hwClosing) return; // 已握手过，放行
    e.preventDefault();
    (win as unknown as { _hwClosing?: boolean })._hwClosing = true;
    try {
      win.webContents.send('ev:prepare-close');
    } catch {
      /* 渲染进程已不可用时直接关 */
    }
    setTimeout(() => {
      try {
        win.close();
      } catch {
        /* 忽略 */
      }
    }, 300);
  });
  const devUrl = process.env.HELPWORK_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    // __dirname = <app>\dist-main\main；渲染产物在 <app>\dist-renderer
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'));
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function scheduleAutoBackup(): void {
  setTimeout(() => {
    try {
      const dir = tryGetDataDir();
      if (!dir || !isDbReady()) return;
      if (needAutoBackup(getMeta, setMeta)) {
        createBackup(dir, dbPath(dir));
        log.info('每日自动备份完成');
      }
    } catch (e) {
      log.warn(`自动备份失败：${(e as Error).message}`);
    }
  }, 8000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    initDataDir();
    if (!getInitError()) scheduleAutoBackup();
    createWindow();
    registerIpc(() => mainWindow);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    try {
      closeDb();
    } catch {
      /* 忽略 */
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

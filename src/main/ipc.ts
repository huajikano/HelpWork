// IPC 层：渲染进程与主进程之间的桥
// 统一返回 { ok, data?, error? }，error 恒为中文；附件导入带进度推送与取消
import { ipcMain, dialog, shell, BrowserWindow, webUtils } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPC } from '../shared/types';
import { log } from './logger';
import { getDataDir, tryGetDataDir, getInitError, setDataDir, setInitError } from './runtime';
import { defaultDataDir, readConfig, writeConfig, checkDataDirUsable } from './config';
import { dbPath, openDb, closeDb, isDbReady } from './db';
import * as svc from './services';
import * as branchesSvc from './branches';
import { storeFile, entityAbsPath, diskUsage, removeEntityIfUnreferenced, cleanTmp, ensureDirs } from './files';
import { createBackup, listBackups } from './backup';
import { exportWorkflowZip, importWorkflowZip } from './transfer';
import { unlp, uuid, nowISO, friendlyError, sanitizeFileName } from './util';

type GetWin = () => BrowserWindow | null;

// 统一返回结构
type R<T> = { ok: true; data: T } | { ok: false; error: string };

function okRes<T>(data: T): R<T> {
  return { ok: true, data };
}

function failRes(error: string): R<never> {
  return { ok: false, error };
}

function wrap<T>(fn: () => T): R<T> {
  try {
    return okRes(fn());
  } catch (e) {
    const msg = friendlyError(e, '操作失败');
    log.error(`IPC 错误：${msg}`);
    return failRes(msg);
  }
}

// 附件导入会话（当前仅支持一个活动导入任务，含取消标志）
interface ImportSession {
  cancelled: boolean;
}
let importSession: ImportSession | null = null;

/** 对一批 sha256 做引用计数清理（彻底删除后调用） */
function cleanupShas(shas: string[]): void {
  const dir = tryGetDataDir();
  if (!dir) return;
  for (const sha of shas) {
    try {
      removeEntityIfUnreferenced(dir, sha);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

export function registerIpc(getWin: GetWin): void {
  const needDb = (): string => getDataDir();

  // ============ 应用 ============
  ipcMain.handle(IPC.INIT, (): R<{ dataDir: string }> => {
    const err = getInitError();
    if (err) return failRes(err);
    return okRes({ dataDir: tryGetDataDir() });
  });

  ipcMain.handle(IPC.RECOVER_CHOOSE, async (): Promise<R<string>> => {
    const win = getWin();
    const r = await dialog.showOpenDialog(win!, {
      title: '选择数据目录（可选已有的 HelpWorkData 或新建空目录）',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || r.filePaths.length === 0) return failRes('未选择目录');
    const dir = r.filePaths[0];
    try {
      const usable = checkDataDirUsable(dir);
      if (!usable.ok) return failRes(`目录不可用：${usable.error ?? ''}`);
      ensureDirs(dir);
      openDb(dir);
      setDataDir(dir);
      setInitError(null);
      writeConfig({ dataDir: dir });
      log.info(`数据目录已恢复指向：${dir}`);
      return okRes(dir);
    } catch (e) {
      return failRes(friendlyError(e, '切换数据目录失败'));
    }
  });

  ipcMain.handle(IPC.RECOVER_DEFAULT, (): R<string> => {
    try {
      const dir = defaultDataDir();
      const usable = checkDataDirUsable(dir);
      if (!usable.ok) return failRes(`默认目录不可用：${usable.error ?? ''}`);
      ensureDirs(dir);
      openDb(dir);
      setDataDir(dir);
      setInitError(null);
      writeConfig({ dataDir: dir });
      return okRes(dir);
    } catch (e) {
      return failRes(friendlyError(e, '切换默认目录失败'));
    }
  });

  ipcMain.handle(IPC.GET_APP_INFO, () =>
    okRes({ version: '1.1.0', electron: process.versions.electron, node: process.versions.node })
  );

  ipcMain.handle(IPC.GET_DATA_DIR, () => okRes(tryGetDataDir()));

  ipcMain.handle(IPC.GET_DISK_USAGE, () => wrap(() => diskUsage(needDb())));

  ipcMain.handle(IPC.OPEN_PATH, (_e, p: string) => {
    void shell.openPath(p);
    return okRes(true);
  });

  ipcMain.handle(IPC.OPEN_IN_FOLDER, (_e, p: string) => {
    shell.showItemInFolder(p);
    return okRes(true);
  });

  ipcMain.handle(IPC.FLUSH_NOTE, () => okRes(true)); // 备注即时保存，无需额外落盘钩子

  ipcMain.handle(IPC.CHOOSE_FILES, async (): Promise<R<string[]>> => {
    const win = getWin();
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要挂到节点的文件',
      properties: ['openFile', 'multiSelections']
    });
    return okRes(r.canceled ? [] : r.filePaths);
  });

  ipcMain.handle(IPC.CHOOSE_IMPORT_ZIP, async (): Promise<R<string | null>> => {
    const win = getWin();
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要导入的流程包（zip）',
      properties: ['openFile'],
      filters: [{ name: 'HelpWork 流程包', extensions: ['zip'] }]
    });
    return okRes(r.canceled ? null : r.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.SELECT_DIRECTORY, async (): Promise<R<string>> => {
    const win = getWin();
    const r = await dialog.showOpenDialog(win!, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || r.filePaths.length === 0) return failRes('未选择目录');
    return okRes(r.filePaths[0]);
  });

  // ============ 流程 ============
  ipcMain.handle(IPC.LIST_WORKFLOWS, () => wrap(() => svc.listWorkflows()));

  ipcMain.handle(IPC.CREATE_WORKFLOW, (_e, name: string) => wrap(() => svc.createWorkflow(String(name).trim() || '未命名流程')));

  ipcMain.handle(IPC.RENAME_WORKFLOW, (_e, id: string, name: string) =>
    wrap(() => {
      svc.renameWorkflow(id, String(name).trim() || '未命名流程');
      return true;
    })
  );

  ipcMain.handle(IPC.DELETE_WORKFLOW, (_e, id: string) =>
    wrap(() => {
      svc.deleteWorkflow(id);
      return true;
    })
  );

  ipcMain.handle(IPC.REORDER_WORKFLOWS, (_e, ids: string[]) => wrap(() => {
    svc.reorderWorkflows(ids);
    return true;
  }));

  // ============ 节点 ============
  ipcMain.handle(IPC.LIST_NODES, (_e, wfId: string) => wrap(() => svc.listNodes(wfId)));

  ipcMain.handle(IPC.CREATE_NODE, (_e, wfId: string, title: string, opts?: { parentId?: string | null; branchId?: string | null }) =>
    wrap(() => {
      const o = opts ?? {};
      const branchId = o.branchId ?? null;
      if (!branchId) {
        // 主线追加门控：存在未全部完成的分叉点且其下还有后续主线节点时禁止
        const chk = branchesSvc.checkMainlineAppend(wfId);
        if (!chk.allowed) {
          const names = chk.blockers
            .map((b) => `「${b.forkTitle}」后未完成分支：${b.unfinished.map((u) => u.name).join('、')}`)
            .join('；');
          throw new Error(`还有并行分支未全部完成，不能在主线继续追加节点。${names}`);
        }
      }
      return svc.createNode(wfId, String(title).trim() || '新节点', undefined, { parentId: o.parentId ?? null, branchId });
    })
  );

  ipcMain.handle(IPC.UPDATE_NODE, (_e, id: string, patch: { title?: string; note?: string }) =>
    wrap(() => {
      svc.updateNode(id, patch);
      return true;
    })
  );

  ipcMain.handle(IPC.DELETE_NODE, (_e, id: string) =>
    wrap(() => {
      svc.deleteNode(id);
      return true;
    })
  );

  ipcMain.handle(IPC.MOVE_NODE, (_e, id: string, delta: -1 | 1) => wrap(() => svc.moveNode(id, delta)));

  ipcMain.handle(IPC.REORDER_NODES, (_e, ids: string[]) =>
    wrap(() => {
      svc.reorderNodes(ids);
      return true;
    })
  );

  // ============ 并行分支 ============
  ipcMain.handle(IPC.LIST_BRANCHES, (_e, wfId: string) => wrap(() => branchesSvc.listBranches(wfId)));

  ipcMain.handle(IPC.CREATE_BRANCHES, (_e, wfId: string, forkNodeId: string, names: string[], rootTitle?: string) =>
    wrap(() => branchesSvc.createBranches(wfId, forkNodeId, names ?? [], rootTitle))
  );

  ipcMain.handle(IPC.RENAME_BRANCH, (_e, branchId: string, name: string) =>
    wrap(() => {
      branchesSvc.renameBranch(branchId, name);
      return true;
    })
  );

  ipcMain.handle(IPC.DELETE_BRANCH, (_e, branchId: string, confirmedCascade: boolean) =>
    wrap(() => branchesSvc.deleteBranch(branchId, { confirmedCascade: !!confirmedCascade }))
  );

  ipcMain.handle(IPC.SET_BRANCH_STATUS, (_e, branchId: string, status: 'active' | 'done') =>
    wrap(() => branchesSvc.setBranchStatus(branchId, status))
  );

  ipcMain.handle(IPC.APPEND_TO_BRANCH, (_e, branchId: string, title: string) =>
    wrap(() => branchesSvc.appendToBranch(branchId, String(title).trim() || '新节点'))
  );

  ipcMain.handle(IPC.GATING_INFO, (_e, wfId: string) =>
    wrap(() => {
      const blockers = branchesSvc.checkMainlineAppend(wfId).blockers;
      return { blocked: blockers.length > 0, blockers };
    })
  );

  // ============ 附件 ============
  ipcMain.handle(IPC.LIST_ATTACHMENTS, (_e, nodeId: string) => wrap(() => svc.listAttachments(nodeId)));

  ipcMain.handle(IPC.IMPORT_ATTACHMENTS, async (_e, nodeId: string, srcPaths: string[]): Promise<R<{ imported: number; skipped: { name: string; reason: string }[] }>> => {
    if (importSession) return failRes('已有导入任务进行中，请稍候或先取消');
    const session: ImportSession = { cancelled: false };
    importSession = session;
    const win = getWin();
    const dataDir = needDb();
    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    try {
      for (let i = 0; i < srcPaths.length; i++) {
        if (session.cancelled) break;
        const src = srcPaths[i];
        const name = path.basename(src);
        // 前置校验：目录与不存在文件直接跳过并给任务书要求的提示
        try {
          const st = fs.statSync(src);
          if (st.isDirectory()) {
            skipped.push({ name, reason: '请拖入文件，暂不支持整个文件夹' });
            continue;
          }
        } catch {
          skipped.push({ name, reason: '文件不存在或无法访问' });
          continue;
        }
        win?.webContents.send(IPC.ATT_IMPORT_PROGRESS, {
          stage: `正在导入 ${i + 1}/${srcPaths.length}：${name}`,
          percent: srcPaths.length > 1 ? Math.floor((i / srcPaths.length) * 100) : -1
        });
        try {
          const stored = await storeFile(dataDir, src, name, {
            onProgress: (copied, total) => {
              win?.webContents.send(IPC.ATT_IMPORT_PROGRESS, {
                stage: `正在导入 ${i + 1}/${srcPaths.length}：${name}（${copied}/${total} 字节）`,
                percent: Math.floor((copied / Math.max(total, 1)) * 100)
              });
            },
            isCancelled: () => session.cancelled
          });
          svc.addAttachmentRow({
            id: uuid(),
            node_id: nodeId,
            sha256: stored.sha256,
            original_name: name,
            stored_path: stored.stored_path,
            size: stored.size,
            ext: path.extname(name).slice(1).toLowerCase() || null,
            created_at: nowISO()
          });
          imported.push(name);
        } catch (e) {
          if ((e as Error).message === 'CANCELLED') break;
          skipped.push({ name, reason: friendlyError(e, '导入失败') });
        }
      }
      win?.webContents.send(IPC.ATT_IMPORT_PROGRESS, { stage: '', percent: 100 });
      return okRes({ imported: imported.length, skipped });
    } finally {
      importSession = null;
      void cleanTmp(dataDir);
    }
  });

  ipcMain.handle(IPC.CANCEL_IMPORT, () => {
    if (importSession) importSession.cancelled = true;
    return okRes(true);
  });

  ipcMain.handle(IPC.OPEN_ATTACHMENT, (_e, attId: string): R<boolean> => {
    try {
      const att = svc.getAttachment(attId);
      if (!att) return failRes('附件不存在或已移除');
      const abs = entityAbsPath(needDb(), att.stored_path);
      if (!fs.existsSync(abs)) return failRes('附件实体文件缺失，可能数据目录不完整');
      void shell.openPath(unlp(abs));
      return okRes(true);
    } catch (e) {
      return failRes(friendlyError(e, '打开文件失败'));
    }
  });

  ipcMain.handle(IPC.SHOW_IN_FOLDER, (_e, attId: string): R<boolean> => {
    try {
      const att = svc.getAttachment(attId);
      if (!att) return failRes('附件不存在或已移除');
      const abs = entityAbsPath(needDb(), att.stored_path);
      if (!fs.existsSync(abs)) return failRes('附件实体文件缺失，可能数据目录不完整');
      shell.showItemInFolder(unlp(abs));
      return okRes(true);
    } catch (e) {
      return failRes(friendlyError(e, '定位文件失败'));
    }
  });

  ipcMain.handle(IPC.RENAME_ATTACHMENT, (_e, attId: string, newName: string) =>
    wrap(() => {
      svc.renameAttachment(attId, sanitizeFileName(newName));
      return true;
    })
  );

  ipcMain.handle(IPC.REMOVE_ATTACHMENT, (_e, attId: string) =>
    wrap(() => {
      svc.removeAttachment(attId);
      return true;
    })
  );

  // ============ 搜索 ============
  ipcMain.handle(IPC.SEARCH, (_e, kw: string) => wrap(() => svc.search(String(kw))));

  // ============ 回收站 ============
  ipcMain.handle(IPC.RECYCLE_LIST, () => wrap(() => svc.listRecycle()));

  ipcMain.handle(IPC.RECYCLE_RESTORE, (_e, kind: string, id: string): R<boolean> => {
    try {
      if (kind === 'workflow') svc.restoreWorkflow(id);
      else if (kind === 'node') svc.restoreNode(id);
      else if (kind === 'branch') branchesSvc.restoreBranch(id);
      else if (kind === 'attachment') svc.restoreAttachment(id);
      else return failRes('未知的回收站条目类型');
      return okRes(true);
    } catch (e) {
      return failRes(friendlyError(e, '还原失败'));
    }
  });

  ipcMain.handle(IPC.RECYCLE_PURGE, (_e, kind: string, id: string): R<boolean> => {
    try {
      let shas: string[] = [];
      if (kind === 'workflow') shas = svc.purgeWorkflow(id);
      else if (kind === 'node') shas = svc.purgeNode(id);
      else if (kind === 'branch') shas = branchesSvc.purgeBranch(id);
      else if (kind === 'attachment') {
        const sha = svc.purgeAttachment(id);
        shas = sha ? [sha] : [];
      } else {
        return failRes('未知的回收站条目类型');
      }
      cleanupShas(shas);
      return okRes(true);
    } catch (e) {
      return failRes(friendlyError(e, '彻底删除失败'));
    }
  });

  ipcMain.handle(IPC.RECYCLE_EMPTY, () =>
    wrap(() => {
      const shas = svc.emptyRecycle();
      cleanupShas(shas);
      return true;
    })
  );

  // ============ 导出 / 导入 ============
  ipcMain.handle(IPC.EXPORT_WORKFLOW, (_e, wfId: string) => wrap(() => exportWorkflowZip(needDb(), wfId)));

  ipcMain.handle(IPC.IMPORT_WORKFLOW, async (_e, zipPath: string): Promise<R<{ workflow_id: string; workflow_name: string }>> => {
    const win = getWin();
    try {
      const result = await importWorkflowZip(needDb(), zipPath, (msg, percent) => {
        win?.webContents.send(IPC.ATT_IMPORT_PROGRESS, { stage: msg, percent });
      });
      return okRes(result);
    } catch (e) {
      return failRes(friendlyError(e, '导入失败'));
    }
  });

  // ============ 备份 ============
  ipcMain.handle(IPC.BACKUP_NOW, () =>
    wrap(() => {
      const dir = needDb();
      closeDbForCheckpointThenReopen();
      return createBackup(dir, dbPath(dir));
    })
  );

  ipcMain.handle(IPC.GET_BACKUPS, () => wrap(() => listBackups(needDb())));

  // ============ 设置：更改数据目录（校验 → 搬移 → 更新配置 → 重载） ============
  ipcMain.handle(IPC.CHANGE_DATA_DIR, async (_e, targetDir: string, moveData: boolean): Promise<R<string>> => {
    try {
      const oldDir = needDb();
      // 1. 校验目标目录可用
      const usable = checkDataDirUsable(targetDir);
      if (!usable.ok) return failRes(`目标目录不可用：${usable.error ?? ''}`);
      // 目标不能是当前目录的子目录（搬移会递归套娃）
      if (path.resolve(targetDir).toLowerCase().startsWith(path.resolve(oldDir).toLowerCase() + path.sep)) {
        return failRes('目标目录不能是当前数据目录的子目录');
      }
      const targetHasDb = fs.existsSync(path.join(targetDir, 'helpwork.db'));
      if (targetHasDb && moveData) {
        return failRes('目标目录已有 HelpWork 数据，请选择空目录或取消勾选「搬移现有数据」');
      }
      // 2. 关库（checkpoint 合并 WAL）
      closeDb();
      try {
        // 3. 搬移（可选）：复制 db + files + backups 到新目录
        if (moveData) {
          copyDirSync(path.join(oldDir, 'helpwork.db'), path.join(targetDir, 'helpwork.db'));
          copyDirSyncKeepWAL(oldDir, targetDir);
        }
        // 4. 打开新目录并写配置
        ensureDirs(targetDir);
        openDb(targetDir);
        setDataDir(targetDir);
        writeConfig({ dataDir: targetDir });
        log.info(`数据目录已切换：${oldDir} → ${targetDir}${moveData ? '（已搬移数据）' : ''}`);
        return okRes(targetDir);
      } catch (e) {
        // 5. 失败回滚：恢复旧目录
        log.error(`数据目录切换失败，回滚：${(e as Error).message}`);
        try {
          openDb(oldDir);
          setDataDir(oldDir);
        } catch {
          setInitError(`数据目录切换失败且旧目录无法恢复：${(e as Error).message}`);
        }
        return failRes(friendlyError(e, '数据目录切换失败，已回滚'));
      }
    } catch (e) {
      return failRes(friendlyError(e, '数据目录切换失败'));
    }
  });

  // ============ 日志 ============
  ipcMain.handle(IPC.LOG, (_e, level: 'info' | 'warn' | 'error', msg: string) => {
    log[level](String(msg).slice(0, 2000));
    return okRes(true);
  });

  // 关库前 checkpoint 已在 closeDb 内实现；备份前重开确保句柄有效
  function closeDbForCheckpointThenReopen(): void {
    const dir = needDb();
    closeDb();
    openDb(dir);
  }

  function copyDirSyncKeepWAL(oldDir: string, targetDir: string): void {
    // 搬移 files/ 与 backups/（db 已单独复制）
    for (const sub of ['files', 'backups']) {
      const src = path.join(oldDir, sub);
      if (!fs.existsSync(src)) continue;
      copyTree(src, path.join(targetDir, sub));
    }
  }

  function copyDirSync(srcFile: string, dstFile: string): void {
    fs.copyFileSync(srcFile, dstFile);
  }

  function copyTree(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) copyTree(s, d);
      else if (e.isFile()) fs.copyFileSync(s, d);
    }
  }

  // 拖拽落点路径（webUtils.getPathForFile 在渲染进程不可用，须在主进程转换）
  ipcMain.handle('app:path-for-file', (_e, file: File) => {
    try {
      return okRes(webUtils.getPathForFile(file));
    } catch {
      return failRes('无法获取拖入文件的路径');
    }
  });
}

// 模态框集合：输入 / 确认 / 回收站 / 设置
import React, { useCallback, useEffect, useState } from 'react';
import type { RecycleItem, DiskUsage } from '../../../shared/types';
import { Modal, fmtSize, fmtTime } from './Common';

const hw = window.helpwork;

export type ModalState =
  | { kind: 'input'; title: string; label: string; initial: string; onOk: (v: string) => Promise<void> | void }
  | { kind: 'confirm'; title: string; message: string; danger?: boolean; onOk: () => Promise<void> | void }
  | { kind: 'createBranches'; title: string; onOk: (names: string[]) => Promise<void> | void }
  | { kind: 'recycle'; title: string }
  | { kind: 'settings'; title: string }
  | null;

interface AppModalProps {
  state: ModalState;
  onCancel: () => void;
  onToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
  onDataChanged: () => Promise<void>;
}

export function AppModal({ state, onCancel, onToast, onDataChanged }: AppModalProps): React.ReactElement | null {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValue(state?.kind === 'input' ? state.initial : '');
  }, [state]);

  if (!state) return null;

  if (state.kind === 'input') {
    return (
      <Modal
        title={state.title}
        onClose={onCancel}
        actions={
          <>
            <button className="btn" onClick={onCancel}>取消</button>
            <button
              className="btn primary"
              disabled={busy || value.trim() === ''}
              onClick={async () => {
                setBusy(true);
                try {
                  await state.onOk(value.trim());
                } finally {
                  setBusy(false);
                }
              }}
            >确定</button>
          </>
        }
      >
        <label style={{ display: 'block', marginBottom: 6, color: 'var(--text-dim)' }}>{state.label}</label>
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              void state.onOk(value.trim());
            }
          }}
        />
      </Modal>
    );
  }

  if (state.kind === 'confirm') {
    return (
      <Modal
        title={state.title}
        onClose={onCancel}
        actions={
          <>
            <button className="btn" onClick={onCancel}>取消</button>
            <button
              className={`btn ${state.danger ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await state.onOk();
                } finally {
                  setBusy(false);
                }
              }}
            >确定</button>
          </>
        }
      >
        {state.message}
      </Modal>
    );
  }

  if (state.kind === 'createBranches') {
    return <CreateBranchesModal state={state} onCancel={onCancel} />;
  }

  if (state.kind === 'recycle') {
    return <RecycleModal onClose={onCancel} onToast={onToast} onDataChanged={onDataChanged} />;
  }

  return <SettingsModal onClose={onCancel} onToast={onToast} />;
}

// ---------- 创建并行分支 ----------
function CreateBranchesModal({ state, onCancel }: {
  state: Extract<ModalState, { kind: 'createBranches' }>;
  onCancel: () => void;
}): React.ReactElement {
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(['分支 1', '分支 2']);
  const [busy, setBusy] = useState(false);
  function changeCount(next: number): void {
    const n = Math.max(2, Math.min(30, Math.floor(next || 2)));
    setCount(n);
    setNames((old) => Array.from({ length: n }, (_, i) => old[i] ?? `分支 ${i + 1}`));
  }
  return (
    <Modal title={state.title} onClose={onCancel} actions={
      <><button className="btn" onClick={onCancel}>取消</button>
        <button className="btn primary" disabled={busy || names.some((n) => !n.trim())} onClick={async () => {
          setBusy(true);
          try { await state.onOk(names.map((n) => n.trim())); } finally { setBusy(false); }
        }}>创建 {count} 条分支</button></>
    }>
      <label style={{ display: 'block', marginBottom: 6, color: 'var(--text-dim)' }}>分支数量（至少 2 条）</label>
      <input type="number" min={2} max={30} value={count} onChange={(e) => changeCount(Number(e.target.value))} />
      <div className="branch-name-fields">
        {names.map((name, i) => <label key={i}>
          <span>分支 {i + 1}</span>
          <input type="text" value={name} onChange={(e) => setNames((old) => old.map((v, j) => j === i ? e.target.value : v))} />
        </label>)}
      </div>
    </Modal>
  );
}

// ---------- 回收站 ----------
function RecycleModal({ onClose, onToast, onDataChanged }: { onClose: () => void; onToast: AppModalProps['onToast']; onDataChanged: () => Promise<void> }): React.ReactElement {
  const [items, setItems] = useState<RecycleItem[] | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setItems(await hw.listRecycle());
    } catch (e) {
      onToast((e as Error).message, 'error');
      setItems([]);
    }
  }, [onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function kindLabel(k: string): string {
    if (k === 'workflow') return '流程';
    if (k === 'node') return '节点';
    if (k === 'branch') return '并行分支';
    return '附件';
  }

  return (
    <Modal
      title="回收站"
      onClose={onClose}
      actions={
        <>
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm('确定清空回收站？彻底删除后无法恢复。')) return;
              try {
                await hw.emptyRecycle();
                await refresh();
                await onDataChanged();
              } catch (e) {
                onToast((e as Error).message, 'error');
              }
            }}
          >清空回收站</button>
          <button className="btn" onClick={onClose}>关闭</button>
        </>
      }
    >
      {items === null && <div className="empty-tip">正在加载…</div>}
      {items !== null && items.length === 0 && <div className="empty-tip">回收站是空的</div>}
      {items !== null && items.length > 0 && (
        <div className="recycle-list">
          {items.map((it) => (
            <div key={it.kind + it.id} className="recycle-item">
              <span>{it.kind === 'workflow' ? '📁' : it.kind === 'node' ? '📌' : it.kind === 'branch' ? '⑂' : '📎'}</span>
              <div className="meta">
                <div className="name">{it.name}</div>
                <div className="kind">{kindLabel(it.kind)} · 删除于 {fmtTime(it.deleted_at)}</div>
              </div>
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    await hw.restoreItem(it.kind, it.id);
                    await refresh();
                    await onDataChanged();
                  } catch (e) {
                    onToast((e as Error).message, 'error');
                  }
                }}
              >还原</button>
              <button
                className="btn small danger"
                onClick={async () => {
                  if (!window.confirm('彻底删除后无法恢复，确定？')) return;
                  try {
                    await hw.purgeItem(it.kind, it.id);
                    await refresh();
                    await onDataChanged();
                  } catch (e) {
                    onToast((e as Error).message, 'error');
                  }
                }}
              >彻底删除</button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------- 设置 ----------
function SettingsModal({ onClose, onToast }: { onClose: () => void; onToast: AppModalProps['onToast'] }): React.ReactElement {
  const [dataDir, setDataDir] = useState('加载中…');
  const [newDir, setNewDir] = useState('');
  const [moveData, setMoveData] = useState(true);
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [backups, setBackups] = useState<{ name: string; size: number; mtime: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void hw.getDataDir().then((d) => {
      setDataDir(d);
      setNewDir(d);
    });
    void hw.getDiskUsage().then(setUsage).catch(() => undefined);
    void hw.listBackups().then(setBackups).catch(() => undefined);
  }, []);

  return (
    <Modal
      title="设置"
      onClose={onClose}
      actions={<button className="btn" onClick={onClose}>关闭</button>}
    >
      <div className="settings-row">
        <label>当前数据目录</label>
        <span title={dataDir} style={{ wordBreak: 'break-all' }}>{dataDir}</span>
      </div>
      <div className="settings-row">
        <label>数据目录占用</label>
        <span>
          {usage
            ? `${fmtSize(usage.files_bytes + usage.db_bytes + usage.backups_bytes)}（附件 ${usage.files_count} 个）`
            : '统计中…'}
        </span>
      </div>
      <div className="settings-row">
        <label>导入流程包</label>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            try {
              const zip = await hw.chooseImportZip();
              if (!zip) return;
              setBusy(true);
              const r = await hw.importWorkflow(zip);
              onToast(`已导入流程「${r.workflow_name}」`, 'success');
              onClose();
            } catch (e) {
              onToast((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >选择 zip 导入…</button>
      </div>
      <div className="settings-row">
        <label>一键备份</label>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            try {
              setBusy(true);
              const out = await hw.backupNow();
              onToast(`备份完成：${out}`, 'success');
              setBackups(await hw.listBackups());
              setUsage(await hw.getDiskUsage());
            } catch (e) {
              onToast((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >立即备份</button>
      </div>
      {backups.length > 0 && (
        <div className="settings-row">
          <label>已有备份</label>
          <div style={{ flex: 1, maxHeight: 120, overflowY: 'auto' }}>
            {backups.map((b) => (
              <div key={b.name} style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {b.name}（{fmtSize(b.size)}）
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="settings-row">
        <label>更改数据目录</label>
        <input className="search-input" value={newDir} onChange={(e) => setNewDir(e.target.value)} />
        <button
          className="btn"
          onClick={async () => {
            try {
              const d = await hw.selectDirectory();
              setNewDir(d);
            } catch {
              /* 取消选择 */
            }
          }}
        >浏览…</button>
      </div>
      <div className="settings-row">
        <label />
        <label style={{ minWidth: 0, flex: 1 }}>
          <input type="checkbox" checked={moveData} onChange={(e) => setMoveData(e.target.checked)} />
          同时搬移现有数据（不勾选则直接指向新目录，要求新目录已有 HelpWork 数据）
        </label>
      </div>
      <div className="settings-row">
        <label />
        <button
          className="btn primary"
          disabled={busy || !newDir.trim() || newDir === dataDir}
          onClick={async () => {
            setBusy(true);
            try {
              await hw.changeDataDir(newDir.trim(), moveData);
              onToast('数据目录已切换，即将重载界面', 'success');
              setTimeout(() => window.location.reload(), 800);
            } catch (e) {
              onToast((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >应用更改</button>
      </div>
    </Modal>
  );
}

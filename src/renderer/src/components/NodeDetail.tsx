// 右栏：节点详情（标题原地编辑 + 备注自动保存 + 附件区）
import React, { useEffect, useRef, useState } from 'react';
import type { NodeItem, Attachment } from '../../../shared/types';
import { extIcon, fmtSize, ContextMenu, MenuItem } from './Common';

const hw = window.helpwork;

interface Props {
  node: NodeItem;
  attachments: Attachment[];
  onToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
  onChanged: () => Promise<void>;
  onImportFiles: (paths: string[]) => Promise<void>;
  onChooseFiles: () => Promise<void>;
  onDropFiles: (e: React.DragEvent) => Promise<void>;
}

export function NodeDetail(props: Props): React.ReactElement {
  const { node, attachments, onToast, onChanged, onImportFiles, onChooseFiles, onDropFiles } = props;
  const [title, setTitle] = useState(node.title);
  const [note, setNote] = useState(node.note ?? '');
  const [noteStatus, setNoteStatus] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;

  // 切换节点时重置本地编辑状态
  useEffect(() => {
    setTitle(node.title);
    setNote(node.note ?? '');
    setNoteStatus('saved');
  }, [node.id]);

  // 标题失焦保存
  async function saveTitle(): Promise<void> {
    const t = title.trim();
    if (!t || t === node.title) {
      setTitle(node.title);
      return;
    }
    try {
      await hw.updateNode(node.id, { title: t });
      await onChanged();
    } catch (e) {
      onToast((e as Error).message, 'error');
      setTitle(node.title);
    }
  }

  // 备注防抖 500ms 自动保存
  useEffect(() => {
    if (note === (node.note ?? '')) return;
    setNoteStatus('dirty');
    const t = setTimeout(async () => {
      setNoteStatus('saving');
      try {
        await hw.updateNode(node.id, { note });
        setNoteStatus('saved');
        void onChanged(); // 刷新列表侧的标题等
      } catch (e) {
        onToast((e as Error).message, 'error');
        setNoteStatus('dirty');
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  // 关窗前强制保存（beforeunload 同步 flush 不可靠，改用主进程 flush 钩子）
  useEffect(() => {
    const flush = (): void => {
      if (noteRef.current !== (node.note ?? '')) {
        void hw.updateNode(node.id, { note: noteRef.current });
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush(); // 卸载时（切换节点）也保存
    };
  }, [node.id, node.note]);

  // 主进程关窗握手：窗口即将关闭时立即落盘备注
  useEffect(() => {
    const off = hw.onPrepareClose(() => {
      if (noteRef.current !== (node.note ?? '')) {
        void hw.updateNode(node.id, { note: noteRef.current });
      }
    });
    return off;
  }, [node.id, node.note]);

  const totalBytes = attachments.reduce((s, a) => s + a.size, 0);

  // 附件右键菜单
  function attMenu(a: Attachment): MenuItem[] {
    return [
      { label: '打开', onClick: () => void openAtt(a) },
      { label: '在文件夹中显示', onClick: () => void showAtt(a) },
      { label: '重命名显示名', separated: true, onClick: () => renameAtt(a) },
      { label: '移除', danger: true, separated: true, onClick: () => void removeAtt(a) }
    ];
  }

  async function openAtt(a: Attachment): Promise<void> {
    try {
      await hw.openAttachment(a.id);
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  }

  async function showAtt(a: Attachment): Promise<void> {
    try {
      await hw.showInFolder(a.id);
    } catch (e) {
      onToast((e as Error).message, 'error');
    }
  }

  function renameAtt(a: Attachment): void {
    const input = window.prompt('新的显示名称：', a.original_name);
    if (input === null) return;
    const name = input.trim();
    if (!name) {
      onToast('名称不能为空');
      return;
    }
    hw.renameAttachment(a.id, name)
      .then(() => onChanged())
      .catch((e) => onToast((e as Error).message, 'error'));
  }

  async function removeAtt(a: Attachment): Promise<void> {
    if (!window.confirm(`确定移除附件「${a.original_name}」？可在回收站找回。`)) return;
    try {
      await hw.removeAttachment(a.id);
      await onChanged();
      onToast('已移除', 'success');
    }  catch (e) {
      onToast((e as Error).message, 'error');
    }
  }

  return (
    <div className="detail-body">
      {/* 标题 */}
      <div>
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>

      {/* 备注 */}
      <div>
        <div className="detail-section-title">
          备注{' '}
          {noteStatus === 'dirty' && <span style={{ color: '#d3455b' }}>· 有未保存修改</span>}
          {noteStatus === 'saving' && <span style={{ color: '#6a737d' }}>· 正在保存…</span>}
          {noteStatus === 'saved' && <span style={{ color: '#2da44e' }}>· 已保存</span>}
        </div>
        <textarea
          className="note-editor"
          value={note}
          placeholder="记录这一步的做法、参数、注意事项…（支持换行，自动保存）"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {/* 附件区 */}
      <div
        className={`attachments ${dragOver ? 'dragover' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { setDragOver(false); void onDropFiles(e); }}
      >
        <div className="att-header">
          <span className="title">附件（{attachments.length}）</span>
          <button className="btn small" onClick={() => void onChooseFiles()}>＋ 添加文件</button>
        </div>
        <div className="att-list">
          {attachments.length === 0 && (
            <div className="empty-tip" style={{ gridColumn: '1 / -1' }}>
              把文件拖到这里，或点击「添加文件」
            </div>
          )}
          {attachments.map((a) => (
            <div
              key={a.id}
              className="att-item"
              onDoubleClick={() => void openAtt(a)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: attMenu(a) });
              }}
              title={`${a.original_name}（双击打开，右键更多操作）`}
            >
              <span className="icon">{extIcon(a.ext)}</span>
              <div className="meta">
                <div className="name">{a.original_name}</div>
                <div className="size">{fmtSize(a.size)}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="att-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
          <span style={{ color: 'var(--text-dim)' }}>{attachments.length} 个附件 · 共 {fmtSize(totalBytes)}</span>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

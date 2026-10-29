// 通用小组件：图标、右键菜单、模态框、toast、拖拽排序辅助
import React, { useEffect, useRef, useState, createContext, useContext } from 'react';

// ---------- SVG 图标（内联，无 CDN） ----------
type IconName =
  | 'workflow'
  | 'node'
  | 'file'
  | 'search'
  | 'trash'
  | 'settings'
  | 'backup'
  | 'export'
  | 'import'
  | 'plus'
  | 'folder'
  | 'up'
  | 'down'
  | 'close'
  | 'check'
  | 'warn';

const ICON_PATHS: Record<IconName, string> = {
  workflow: 'M3 5h8v4H3zM13 5h8v4h-8zM7 9v3h10V9M12 12v3',
  node: 'M4 6h16M4 12h16M4 18h10',
  file: 'M6 2h9l5 5v15H6zM15 2v5h5',
  search: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM14.5 14.5L21 21',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1',
  backup: 'M12 3v10M8 9l4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 /node 0 0-2-2v-2',
  export: 'M12 15V5M8 9l4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  import: 'M12 3v10M8 9l4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 6h6l2 2h10v12H3z',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12l5 5L20 7',
  warn: 'M12 3l10 18H2zM12 10v4M12 17v.5'
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ---------- 文件类型图标（按扩展名） ----------
const EXT_ICON_MAP: Record<string, string> = {
  pdf: '📄',
  doc: '📄', docx: '📄', txt: '📄', md: '📄',
  xls: '📊', xlsx: '📊', csv: '📊',
  ppt: '📽', pptx: '📽',
  jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', bmp: '🖼',
  zip: '🗜', rar: '🗜', '7z': '🗜',
  exe: '⚙', msi: '⚙', bat: '⚙', ps1: '⚙',
  js: '📜', ts: '📜', json: '📜', py: '📜',
  mp3: '🎵', wav: '🎵', mp4: '🎬', mkv: '🎬',
  default: '📎'
};

export function extIcon(ext: string | null | undefined): string {
  if (!ext) return EXT_ICON_MAP.default;
  return EXT_ICON_MAP[ext.toLowerCase()] ?? EXT_ICON_MAP.default;
}

// ---------- 右键菜单 ----------
export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separated?: boolean; // 前置分隔线
  disabled?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div className="context-menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((it, i) => (
        <React.Fragment key={it.label}>
          {it.separated && <div className="menu-sep" />}
          <button className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { it.onClick?.(); onClose(); }}>
            {it.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------- 模态框 ----------
export function Modal({ title, children, onClose, actions }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions ?? <button className="btn" onClick={onClose}>关闭</button>}</div>
      </div>
    </div>
  );
}

// ---------- Toast ----------
export interface ToastMsg { id: number; text: string; kind: 'info' | 'success' | 'error' }

export function ToastArea({ toasts }: { toasts: ToastMsg[] }) {
  return (
    <div className="toast-area">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

// ---------- 拖拽排序（HTML5 原生 drag events 封装） ----------
export function useDragOrder<T extends { id: string }>(
  items: T[],
  onReorder: (ids: string[]) => void
): {
  dragIndex: React.MutableRefObject<number>;
  handlers: (id: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
  dragOverIndex: number;
} {
  const dragIndex = useRef(-1);
  const [dragOverIndex, setDragOverIndex] = useState(-1);
  const handlers = (id: string) => ({
    draggable: true as const,
    onDragStart: () => {
      dragIndex.current = items.findIndex((it) => it.id === id);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      const idx = items.findIndex((it) => it.id === id);
      if (idx >= 0) setDragOverIndex(idx);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragIndex.current;
      const to = items.findIndex((it) => it.id === id);
      dragIndex.current = -1;
      setDragOverIndex(-1);
      if (from < 0 || to < 0 || from === to) return;
      const ids = items.map((it) => it.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      onReorder(ids);
    },
    onDragEnd: () => {
      dragIndex.current = -1;
      setDragOverIndex(-1);
    }
  });
  return { dragIndex, handlers, dragOverIndex };
}

// ---------- 格式化 ----------
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------- 日期时间格式化 ----------
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

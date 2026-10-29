// 数据目录不可用时的恢复界面
import React, { useState } from 'react';

const hw = window.helpwork;

export function RecoverScreen({ error, onRecovered }: { error: string; onRecovered: (dir: string) => Promise<void> }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  return (
    <div className="recover-screen">
      <div className="icon">⚠️</div>
      <h2 style={{ margin: 0 }}>数据目录无法访问</h2>
      <div style={{ maxWidth: 520, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{error}</div>
      <div style={{ color: 'var(--text-dim)', maxWidth: 520 }}>
        可能是数据目录被移动、磁盘未接入或权限变化。你可以：
        <br />1. 选择一个新的空目录重新开始；
        <br />2. 选择已复制过来的 HelpWorkData 数据目录继续使用；
        <br />3. 使用默认位置新建。
      </div>
      {msg && <div style={{ color: 'var(--danger)' }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 12 }}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg('');
            try {
              const dir = await hw.recoverChoose();
              await onRecovered(dir);
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >选择数据目录…</button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg('');
            try {
              const dir = await hw.recoverDefault();
              await onRecovered(dir);
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >使用默认位置新建</button>
      </div>
    </div>
  );
}

// 应用主组件：三栏布局 + 全局状态
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Workflow, NodeItem, Attachment, SearchHit, DiskUsage, ImportProgress, BranchItem } from '../../shared/types';
import { Icon, ContextMenu, MenuItem, ToastArea, ToastMsg, useDragOrder, fmtSize } from './components/Common';
import { NodeDetail } from './components/NodeDetail';
import { AppModal, ModalState } from './components/Modals';
import { RecoverScreen } from './components/RecoverScreen';

const hw = window.helpwork;

type Screen = 'loading' | 'recover' | 'main';

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>('loading');
  const [initError, setInitError] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [version, setVersion] = useState('');

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [currentWfId, setCurrentWfId] = useState('');
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState('');
  const [expandedForks, setExpandedForks] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [searchKw, setSearchKw] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [highlightNodeId, setHighlightNodeId] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [wfFilter, setWfFilter] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const toast = useCallback((text: string, kind: ToastMsg['kind'] = 'info'): void => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3200);
  }, []);

  // ---------- 初始化 ----------
  useEffect(() => {
    (async (): Promise<void> => {
      try {
        const r = await hw.init();
        setDataDir(r.dataDir);
        setScreen('main');
        const wfs = await hw.listWorkflows();
        setWorkflows(wfs);
        if (wfs.length > 0) setCurrentWfId(wfs[0].id);
        hw.getAppInfo().then((i) => setVersion(i.version)).catch(() => undefined);
        hw.getDiskUsage().then(setUsage).catch(() => undefined);
      } catch (e) {
        setInitError((e as Error).message);
        setScreen('recover');
      }
    })();
  }, []);

  // 选中流程 → 加载节点
  useEffect(() => {
    if (!currentWfId) {
      setNodes([]);
      setCurrentNodeId('');
      return;
    }
    Promise.all([hw.listNodes(currentWfId), hw.listBranches(currentWfId)])
      .then(([ns, bs]) => {
        setNodes(ns);
        setBranches(bs);
        // 含分支的流程：恢复上次记录位置（纯线性流程保持原有行为，不自动选中）
        if (bs.length > 0) {
          const saved = localStorage.getItem(`hw.pos.${currentWfId}`);
          if (saved && ns.some((n) => n.id === saved)) setCurrentNodeId(saved);
        }
      })
      .catch((e) => toast((e as Error).message, 'error'));
  }, [currentWfId, toast]);

  // 当前位置：自动展开所在路径上的分叉点，并记住位置（重启后恢复）
  useEffect(() => {
    if (!currentNodeId || !currentWfId) return;
    const n = nodes.find((x) => x.id === currentNodeId);
    if (!n || n.workflow_id !== currentWfId) return;
    if (branches.length > 0) localStorage.setItem(`hw.pos.${currentWfId}`, currentNodeId);
    const forks: string[] = [];
    const seen = new Set<string>();
    let cur: NodeItem | undefined = n;
    while (cur && cur.branch_id && !seen.has(cur.id)) {
      seen.add(cur.id);
      const b = branches.find((x) => x.id === cur!.branch_id);
      if (!b) break;
      forks.push(b.fork_node_id);
      cur = nodes.find((x) => x.id === b.fork_node_id);
    }
    if (forks.some((f) => !expandedForks.has(f))) {
      setExpandedForks((old) => { const s = new Set(old); forks.forEach((f) => s.add(f)); return s; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNodeId, nodes, branches, currentWfId]);

  // 选中节点 → 加载附件
  useEffect(() => {
    if (!currentNodeId) {
      setAttachments([]);
      return;
    }
    hw.listAttachments(currentNodeId).then(setAttachments).catch((e) => toast((e as Error).message, 'error'));
  }, [currentNodeId, toast]);

  // 导入进度订阅
  useEffect(() => {
    return hw.onImportProgress((p) => {
      if (p.stage === '' && p.percent >= 100) setImportProgress(null);
      else setImportProgress(p);
    });
  }, []);

  // Ctrl+F 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- 刷新 ----------
  const refreshWorkflows = useCallback(async (): Promise<void> => {
    const wfs = await hw.listWorkflows();
    setWorkflows(wfs);
    if (wfs.length > 0 && !wfs.find((w) => w.id === currentWfId)) setCurrentWfId(wfs[0].id);
    if (wfs.length === 0) {
      setCurrentWfId('');
      setCurrentNodeId('');
    }
    hw.getDiskUsage().then(setUsage).catch(() => undefined);
  }, [currentWfId]);

  const refreshNodes = useCallback(async (): Promise<void> => {
    if (!currentWfId) return;
    const [ns, bs] = await Promise.all([hw.listNodes(currentWfId), hw.listBranches(currentWfId)]);
    setNodes(ns);
    setBranches(bs);
    const trunk = ns.filter((n) => !n.branch_id);
    if (ns.length > 0 && !ns.find((n) => n.id === currentNodeId)) setCurrentNodeId(trunk[0]?.id ?? ns[0].id);
    if (ns.length === 0) setCurrentNodeId('');
  }, [currentWfId, currentNodeId]);

  const refreshAttachments = useCallback(async (): Promise<void> => {
    if (!currentNodeId) {
      setAttachments([]);
      return;
    }
    setAttachments(await hw.listAttachments(currentNodeId));
    hw.getDiskUsage().then(setUsage).catch(() => undefined);
  }, [currentNodeId]);

  // ---------- 流程/主线节点拖拽排序 ----------
  const trunkNodes = nodes.filter((n) => !n.branch_id).sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  const wfDrag = useDragOrder(workflows, (ids) => void applyWfOrder(ids));
  const nodeDrag = useDragOrder(trunkNodes, (ids) => void applyNodeOrder(ids));

  async function applyWfOrder(ids: string[]): Promise<void> {
    const old = workflows.map((w) => w.id).join(',');
    if (ids.join(',') === old) return;
    const prev = workflows;
    setWorkflows(ids.map((id) => prev.find((w) => w.id === id)!).filter(Boolean));
    try {
      await hw.reorderWorkflows(ids);
    } catch (e) {
      toast((e as Error).message, 'error');
      void refreshWorkflows();
    }
  }

  async function applyNodeOrder(ids: string[]): Promise<void> {
    const old = trunkNodes.map((n) => n.id).join(',');
    if (ids.join(',') === old) return;
    const prev = trunkNodes;
    const ordered = ids.map((id) => prev.find((n) => n.id === id)!).filter(Boolean);
    try {
      await hw.reorderNodes(ids);
      void refreshNodes();
    } catch (e) {
      toast((e as Error).message, 'error');
      void refreshNodes();
    }
  }

  // ---------- 搜索（防抖 300ms） ----------
  useEffect(() => {
    const kw = searchKw.trim();
    if (!kw) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(() => {
      hw.search(kw).then(setSearchHits).catch((e) => toast((e as Error).message, 'error'));
    }, 300);
    return () => clearTimeout(t);
  }, [searchKw, toast]);

  // ---------- 流程操作 ----------
  function doCreateWorkflow(): void {
    setModal({
      kind: 'input', title: '新建流程', label: '流程名称', initial: '',
      onOk: async (name) => {
        try {
          const w = await hw.createWorkflow(name);
          setModal(null);
          await refreshWorkflows();
          setCurrentWfId(w.id);
          toast(`已新建流程「${w.name}」`, 'success');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    });
  }

  function doRenameWorkflow(w: Workflow): void {
    setModal({
      kind: 'input', title: '重命名流程', label: '流程名称', initial: w.name,
      onOk: async (name) => {
        try {
          await hw.renameWorkflow(w.id, name);
          setModal(null);
          await refreshWorkflows();
          toast('已重命名', 'success');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    });
  }

  function doDeleteWorkflow(w: Workflow): void {
    setModal({
      kind: 'confirm', title: '删除流程',
      message: `确定删除流程「${w.name}」？其中所有节点与附件将进入回收站。`,
      danger: true,
      onOk: async () => {
        try {
          await hw.deleteWorkflow(w.id);
          setModal(null);
          await refreshWorkflows();
          toast('已删除（可在回收站找回）', 'success');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    });
  }

  async function doExportWorkflow(w: Workflow): Promise<void> {
    try {
      const out = await hw.exportWorkflow(w.id);
      toast(`已导出：${out}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  // ---------- 节点操作 ----------
  function doCreateNode(): void {
    if (!currentWfId) return;
    setModal({
      kind: 'input', title: '添加节点', label: '节点标题', initial: '',
      onOk: async (title) => {
        try {
          const n = await hw.createNode(currentWfId, title);
          setModal(null);
          await refreshNodes();
          setCurrentNodeId(n.id);
          toast(`已添加节点「${n.title}」`, 'success');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    });
  }

  function doRenameNode(n: NodeItem): void {
    setModal({
      kind: 'input', title: '节点重命名', label: '节点标题', initial: n.title,
      onOk: async (title) => {
        try {
          await hw.updateNode(n.id, { title });
          setModal(null);
          await refreshNodes();
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    });
  }

  function doDeleteNode(n: NodeItem): void {
    const children = branches.filter((b) => b.fork_node_id === n.id);
    if (children.length > 0) {
      toast(`该步骤下有 ${children.length} 条并行分支，请先处理或删除这些分支`, 'error');
      return;
    }
    setModal({
      kind: 'confirm', title: '删除节点',
      message: `确定删除节点「${n.title}」？其备注与附件将进入回收站。`,
      danger: true,
      onOk: async () => {
        try {
          await hw.deleteNode(n.id);
          setModal(null);
          await refreshNodes();
          toast('已删除（可在回收站找回）', 'success');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    });
  }

  async function doMoveNode(id: string, delta: -1 | 1): Promise<void> {
    try {
      await hw.moveNode(id, delta);
      await refreshNodes();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  function doCreateBranches(n: NodeItem): void {
    setModal({
      kind: 'createBranches', title: `在「${n.title}」创建并行分支`,
      onOk: async (names) => {
        try {
          const r = await hw.createBranches(currentWfId, n.id, names);
          setExpandedForks((old) => new Set(old).add(n.id));
          setCurrentNodeId(r.roots[0]?.id ?? n.id);
          setModal(null);
          await refreshNodes();
          toast(`已创建 ${r.branches.length} 条并行分支`, 'success');
        } catch (e) { toast((e as Error).message, 'error'); }
      }
    });
  }

  function doAppendBranch(b: BranchItem): void {
    setModal({ kind: 'input', title: `在「${b.name}」添加步骤`, label: '步骤标题', initial: '', onOk: async (title) => {
      try {
        const n = await hw.appendToBranch(b.id, title);
        setModal(null);
        await refreshNodes();
        setCurrentNodeId(n.id);
        toast(`已添加到分支「${b.name}」`, 'success');
      } catch (e) { toast((e as Error).message, 'error'); }
    }});
  }

  function doRenameBranch(b: BranchItem): void {
    setModal({ kind: 'input', title: '重命名分支', label: '分支名称', initial: b.name, onOk: async (name) => {
      try { await hw.renameBranch(b.id, name); setModal(null); await refreshNodes(); toast('分支已重命名', 'success'); }
      catch (e) { toast((e as Error).message, 'error'); }
    }});
  }

  async function toggleBranchStatus(b: BranchItem): Promise<void> {
    try {
      const next = b.status === 'done' ? 'active' : 'done';
      await hw.setBranchStatus(b.id, next);
      await refreshNodes();
      toast(next === 'done' ? `分支「${b.name}」已标记完成` : `已取消「${b.name}」的完成标记`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  function countBranchSteps(branchId: string, seen = new Set<string>()): number {
    if (seen.has(branchId)) return 0;
    seen.add(branchId);
    const own = nodes.filter((n) => n.branch_id === branchId);
    return own.length + own.reduce((sum, n) => sum + branches.filter((child) => child.fork_node_id === n.id)
      .reduce((inner, child) => inner + countBranchSteps(child.id, seen), 0), 0);
  }

  function doDeleteBranch(b: BranchItem): void {
    const count = countBranchSteps(b.id);
    setModal({ kind: 'confirm', title: '删除并行分支', message: `确定删除分支「${b.name}」及其 ${count} 个步骤？嵌套分支也会一并移入回收站。`, danger: true, onOk: async () => {
      try {
        await hw.deleteBranch(b.id, true);
        setModal(null);
        await refreshNodes();
        toast('分支已移入回收站', 'success');
      } catch (e) { toast((e as Error).message, 'error'); }
    }});
  }

  function nodeContextMenu(e: React.MouseEvent, n: NodeItem, siblingIndex: number, siblingCount: number): void {
    e.preventDefault();
    setCurrentNodeId(n.id);
    const items: MenuItem[] = [
      { label: '重命名', onClick: () => doRenameNode(n) },
      { label: '在此创建并行分支…', onClick: () => doCreateBranches(n) },
      { label: '上移', disabled: siblingIndex === 0, onClick: () => void doMoveNode(n.id, -1) },
      { label: '下移', disabled: siblingIndex >= siblingCount - 1, onClick: () => void doMoveNode(n.id, 1) },
      { label: '删除', danger: true, separated: true, onClick: () => doDeleteNode(n) }
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  // ---------- 附件操作 ----------
  async function doImportFiles(srcPaths: string[]): Promise<void> {
    if (!currentNodeId || srcPaths.length === 0) return;
    try {
      const r = await hw.importAttachments(currentNodeId, srcPaths);
      await refreshAttachments();
      await refreshNodes();
      const extra = r.skipped.length > 0 ? `，${r.skipped.length} 个失败` : '';
      toast(`已导入 ${r.imported} 个文件${extra}`, r.skipped.length > 0 ? 'info' : 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function doChooseFiles(): Promise<void> {
    try {
      const paths = await hw.chooseFiles();
      if (paths.length > 0) await doImportFiles(paths);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function onDropFiles(e: React.DragEvent): Promise<void> {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // 目录拖入检测（无扩展名且 4096 倍数大小的启发式不可靠，直接看 FileList API 类型）
    const paths: string[] = [];
    for (const f of files) {
      try {
        paths.push(await hw.pathForFile(f));
      } catch {
        /* 单个失败跳过 */
      }
    }
    if (paths.length === 0) {
      toast('请拖入文件，暂不支持整个文件夹', 'info');
      return;
    }
    await doImportFiles(paths);
  }

  // ---------- 搜索跳转 ----------
  function jumpTo(h: SearchHit): void {
    setSearchKw('');
    setSearchHits(null);
    setCurrentWfId(h.workflow_id);
    setTimeout(() => {
      setCurrentNodeId(h.node_id);
      setHighlightNodeId(h.node_id);
      setTimeout(() => setHighlightNodeId(''), 2000);
    }, 80);
  }

  // ---------- 渲染 ----------
  if (screen === 'loading') {
    return (
      <div className="app">
        <div className="recover-screen">
          <div className="icon">⏳</div>
          <div>正在打开数据目录…</div>
        </div>
      </div>
    );
  }

  if (screen === 'recover') {
    return <RecoverScreen error={initError} onRecovered={async (dir) => {
      setDataDir(dir);
      setInitError('');
      setScreen('main');
      const wfs = await hw.listWorkflows();
      setWorkflows(wfs);
      if (wfs.length > 0) setCurrentWfId(wfs[0].id);
    }} />;
  }

  const currentWf = workflows.find((w) => w.id === currentWfId);
  const currentNode = nodes.find((n) => n.id === currentNodeId);

  // ---------- 分支树派生数据 ----------
  const byOrder = (a: NodeItem, b: NodeItem): number => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
  const branchesByFork = new Map<string, BranchItem[]>();
  for (const b of branches) {
    const arr = branchesByFork.get(b.fork_node_id) ?? [];
    arr.push(b);
    branchesByFork.set(b.fork_node_id, arr);
  }
  const nodesByBranch = new Map<string, NodeItem[]>();
  for (const n of nodes) {
    if (!n.branch_id) continue;
    const arr = nodesByBranch.get(n.branch_id) ?? [];
    arr.push(n);
    nodesByBranch.set(n.branch_id, arr);
  }
  nodesByBranch.forEach((arr) => arr.sort(byOrder));

  // 门控：某条路径（主线或分支）上的第一个未全完成的分叉点
  function gateOfPath(pathNodes: NodeItem[]): { forkTitle: string; names: string[] } | null {
    const blockers: { title: string; names: string[] }[] = [];
    for (const n of pathNodes) {
      const unfinished = (branchesByFork.get(n.id) ?? []).filter((b) => b.status !== 'done');
      if (unfinished.length > 0) blockers.push({ title: n.title, names: unfinished.map((b) => b.name) });
    }
    if (blockers.length === 0) return null;
    return {
      forkTitle: blockers.map((b) => b.title).join('、'),
      names: [...new Set(blockers.flatMap((b) => b.names))]
    };
  }
  const trunkGate = gateOfPath(trunkNodes);

  // 当前路径：选中节点 → 所属分支 → 分叉点 → … → 主线
  const pathIds = new Set<string>();
  const pathLabels: string[] = [];
  {
    let cur = currentNode;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      pathIds.add(cur.id);
      if (!cur.branch_id) { pathLabels.unshift(`主线 · ${cur.title}`); break; }
      const b = branches.find((x) => x.id === cur!.branch_id);
      if (!b) break;
      pathLabels.unshift(`分支「${b.name}」· ${cur.title}`);
      cur = nodes.find((x) => x.id === b.fork_node_id);
    }
  }

  // 活动位置集合：主线末端 + 每条未完成分支的末端
  const tailIds = new Set<string>();
  if (trunkNodes.length > 0) tailIds.add(trunkNodes[trunkNodes.length - 1].id);
  for (const b of branches) {
    if (b.status === 'done') continue;
    const arr = nodesByBranch.get(b.id);
    if (arr && arr.length > 0) tailIds.add(arr[arr.length - 1].id);
  }

  const BRANCH_COLORS = ['#2f6fed', '#1a7f37', '#b08800', '#8250df', '#d3455b', '#0e8a8a'];

  function renderForkChip(n: NodeItem): React.ReactNode {
    const bs = branchesByFork.get(n.id);
    if (!bs || bs.length === 0) return null;
    const done = bs.filter((b) => b.status === 'done').length;
    const open = expandedForks.has(n.id);
    return (
      <button
        className={`fork-chip ${done === bs.length ? 'all-done' : ''}`}
        title={`${done}/${bs.length} 条分支已完成，点击${open ? '折叠' : '展开'}`}
        onClick={(e) => {
          e.stopPropagation();
          setExpandedForks((old) => { const s = new Set(old); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); return s; });
        }}
      >{open ? '▾' : '▸'} 并行 {done}/{bs.length}</button>
    );
  }

  function branchMenu(e: React.MouseEvent, b: BranchItem): void {
    e.preventDefault();
    e.stopPropagation();
    const nestedGate = gateOfPath(nodesByBranch.get(b.id) ?? []);
    setMenu({
      x: e.clientX, y: e.clientY, items: [
        { label: '添加步骤', disabled: b.status === 'done' || !!nestedGate, onClick: () => doAppendBranch(b) },
        { label: b.status === 'done' ? '取消完成标记' : '标记完成', disabled: b.status !== 'done' && !!nestedGate, onClick: () => void toggleBranchStatus(b) },
        { label: '重命名分支', separated: true, onClick: () => doRenameBranch(b) },
        { label: '删除分支', danger: true, separated: true, onClick: () => doDeleteBranch(b) }
      ]
    });
  }

  function renderBranches(fork: NodeItem, label: string, depth: number): React.ReactNode {
    const bs = branchesByFork.get(fork.id);
    if (!bs || bs.length === 0 || !expandedForks.has(fork.id)) return null;
    return (
      <div className="branch-group" style={{ marginLeft: depth === 1 ? 14 : 10 }}>
        {bs.map((b, bi) => {
          const steps = nodesByBranch.get(b.id) ?? [];
          const gate = gateOfPath(steps);
          const color = BRANCH_COLORS[(bi + depth) % BRANCH_COLORS.length];
          return (
            <div key={b.id} className={`branch-block ${b.status === 'done' ? 'done' : ''}`} style={{ borderLeftColor: color }}>
              <div className="branch-head" onContextMenu={(e) => branchMenu(e, b)}>
                <span className="b-name" style={{ color }}>⑂ {b.name}</span>
                <button
                  className={`status-chip ${b.status}`}
                  disabled={b.status !== 'done' && !!gate}
                  title={b.status === 'done' ? '点击取消完成标记' : gate ? `先完成嵌套分支：${gate.names.join('、')}` : '点击标记为已完成'}
                  onClick={() => void toggleBranchStatus(b)}
                >{b.status === 'done' ? '✓ 已完成' : '进行中'}</button>
                <span className="spacer" />
                <button
                  className="btn small"
                  disabled={b.status === 'done' || !!gate}
                  title={b.status === 'done' ? '已完成的分支需先取消完成标记' : gate ? `暂停：还差 ${gate.names.join('、')}` : '在此分支末尾添加步骤'}
                  onClick={() => doAppendBranch(b)}
                >＋ 步骤</button>
                <button className="btn small" title="更多操作" onClick={(e) => branchMenu(e, b)}>⋯</button>
              </div>
              {gate && (
                <div className="gate-banner small">⏸ 分叉点「{gate.forkTitle}」还差：{gate.names.join('、')}</div>
              )}
              {steps.map((s, si) => {
                const sl = `${label}.${bi + 1}.${si + 1}`;
                return (
                  <React.Fragment key={s.id}>
                    <div
                      className={`node-item branch-step ${s.id === currentNodeId ? 'active' : ''} ${s.id === highlightNodeId ? 'highlight-2s' : ''} ${pathIds.has(s.id) && s.id !== currentNodeId ? 'on-path' : ''}`}
                      onClick={() => setCurrentNodeId(s.id)}
                      onContextMenu={(e) => nodeContextMenu(e, s, si, steps.length)}
                    >
                      <span className="ord">{sl}</span>
                      <span className="title">{s.title}</span>
                      {renderForkChip(s)}
                      {tailIds.has(s.id) && <span className="tail-mark" title="该分支当前末端">末端</span>}
                      <span className="badge">📎 {s.attachment_count ?? 0}</span>
                    </div>
                    {renderBranches(s, sl, depth + 1)}
                  </React.Fragment>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }
  const filteredWfs = wfFilter.trim() ? workflows.filter((w) => w.name.includes(wfFilter.trim())) : workflows;

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <header className="topbar">
        <span className="logo">HelpWork 工作流档案柜</span>
        <input
          ref={searchInputRef}
          className="search-input"
          style={{ width: 320 }}
          placeholder="搜索节点 / 备注 / 附件名（Ctrl+F）"
          value={searchKw}
          onChange={(e) => setSearchKw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setSearchKw(''); }}
        />
        <span className="spacer" />
        <button className="btn" onClick={() => setModal({ kind: 'recycle', title: '回收站' })}>回收站</button>
        <button className="btn" onClick={() => setModal({ kind: 'settings', title: '设置' })}>设置</button>
      </header>

      {searchHits !== null && (
        <div className="search-results">
          {searchHits.length === 0 && <div className="empty-tip">没有找到与「{searchKw}」相关的内容</div>}
          {searchHits.map((h) => (
            <div key={h.node_id + h.match_type} className="search-result-item" onClick={() => jumpTo(h)}>
              <div className="wf">{h.workflow_name} › 匹配：{hitLabel(h.match_type)}</div>
              <div className="node-title">{h.node_title}</div>
              {h.match_text && <div className="snippet">{h.match_text.slice(0, 120)}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="main-area">
        <aside className="sidebar">
          <div className="sidebar-header">
            <button className="btn primary" onClick={doCreateWorkflow}>＋ 新建流程</button>
          </div>
          <div className="sidebar-header">
            <input className="search-input" placeholder="筛选流程" value={wfFilter} onChange={(e) => setWfFilter(e.target.value)} />
          </div>
          <div className="wf-list">
            {filteredWfs.length === 0 && (
              <div className="empty-tip">还没有流程<br />点击左上角「新建流程」开始</div>
            )}
            {filteredWfs.map((w) => (
              <div
                key={w.id}
                className={`wf-item ${w.id === currentWfId ? 'active' : ''} ${wfDrag.dragOverIndex >= 0 && workflows[wfDrag.dragOverIndex]?.id === w.id ? 'drag-over' : ''}`}
                onClick={() => setCurrentWfId(w.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCurrentWfId(w.id);
                  setMenu({
                    x: e.clientX, y: e.clientY, items: [
                      { label: '重命名', onClick: () => doRenameWorkflow(w) },
                      { label: '导出此流程', onClick: () => void doExportWorkflow(w) },
                      { label: '删除', danger: true, separated: true, onClick: () => doDeleteWorkflow(w) }
                    ]
                  });
                }}
                {...wfDrag.handlers(w.id)}
              >
                <span className="name">{w.name}</span>
                <span className="badge">{w.node_count ?? 0}</span>
              </div>
            ))}
          </div>
        </aside>

        <section className="node-pane">
          <div className="node-pane-header">
            <span className="title">{currentWf ? currentWf.name : '未选择流程'}</span>
            {branches.length > 0 && (
              <>
                <button className="btn small" title="展开全部分叉点" onClick={() => setExpandedForks(new Set(branches.map((b) => b.fork_node_id)))}>展开</button>
                <button className="btn small" title="折叠全部分叉点" onClick={() => setExpandedForks(new Set())}>折叠</button>
              </>
            )}
            <button
              className="btn"
              disabled={!currentWfId || !!trunkGate}
              title={trunkGate ? `主线暂停：还差 ${trunkGate.names.join('、')}` : undefined}
              onClick={doCreateNode}
            >＋ 添加节点</button>
          </div>
          {trunkGate && (
            <div className="gate-banner">
              ⏸ 主线暂停：分叉点「{trunkGate.forkTitle}」还有 {trunkGate.names.length} 条分支未完成（{trunkGate.names.join('、')}），全部标记完成后才能继续添加主线步骤。
            </div>
          )}
          <div className="node-list">
            {!currentWfId && <div className="empty-tip">请先在左侧选择一条流程</div>}
            {currentWfId && nodes.length === 0 && (
              <div className="empty-tip">这条流程还没有节点<br />点击上方「添加节点」开始</div>
            )}
            {trunkNodes.map((n, i) => (
              <React.Fragment key={n.id}>
                <div
                  className={`node-item ${n.id === currentNodeId ? 'active' : ''} ${n.id === highlightNodeId ? 'highlight-2s' : ''} ${nodeDrag.dragOverIndex === i ? 'drag-over' : ''} ${pathIds.has(n.id) && n.id !== currentNodeId ? 'on-path' : ''}`}
                  onClick={() => setCurrentNodeId(n.id)}
                  onContextMenu={(e) => nodeContextMenu(e, n, i, trunkNodes.length)}
                  {...nodeDrag.handlers(n.id)}
                >
                  <span className="ord">{i + 1}</span>
                  <span className="title">{n.title}</span>
                  {renderForkChip(n)}
                  {tailIds.has(n.id) && branches.length > 0 && <span className="tail-mark" title="主线当前末端">末端</span>}
                  <span className="badge">📎 {n.attachment_count ?? 0}</span>
                </div>
                {renderBranches(n, String(i + 1), 1)}
              </React.Fragment>
            ))}
          </div>
        </section>

        <section className="detail-pane">
          {!currentNode && (
            <div className="detail-empty">
              <Icon name="node" size={48} />
              <div>选中一个节点后，这里显示它的备注与附件</div>
            </div>
          )}
          {currentNode && branches.length > 0 && pathLabels.length > 0 && (
            <div className="path-crumb" title={pathLabels.join(' › ')}>
              当前位置：{pathLabels.join(' › ')}
            </div>
          )}
          {currentNode && (
            <NodeDetail
              node={currentNode}
              attachments={attachments}
              onToast={toast}
              onChanged={async () => { await refreshNodes(); await refreshAttachments(); }}
              onImportFiles={doImportFiles}
              onChooseFiles={doChooseFiles}
              onDropFiles={onDropFiles}
            />
          )}
        </section>
      </div>

      <footer className="statusbar">
        <button title="点击打开数据目录所在文件夹" onClick={() => { void hw.openPath(dataDir); }}>
          📁 {dataDir}
        </button>
        {usage && <span>已用 {fmtSize(usage.files_bytes + usage.db_bytes + usage.backups_bytes)}</span>}
        {version && <span>v{version}</span>}
      </footer>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {modal && <AppModal state={modal} onCancel={() => setModal(null)} onToast={toast} onDataChanged={async () => { await refreshWorkflows(); await refreshNodes(); }} />}
      <ToastArea toasts={toasts} />
      {importProgress && (
        <div className="import-progress">
          <span>{importProgress.stage}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${importProgress.percent < 0 ? 100 : importProgress.percent}%`, opacity: importProgress.percent < 0 ? 0.35 : 1 }} />
          </div>
          <button className="btn small" onClick={() => { void hw.cancelImport(); }}>取消</button>
        </div>
      )}
    </div>
  );

  function hitLabel(t: SearchHit['match_type']): string {
    if (t === 'title') return '节点标题';
    if (t === 'note') return '备注';
    return '附件名';
  }
}

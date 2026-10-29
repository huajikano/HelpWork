// 服务层自测：直接用 Node 跑编译后的主进程业务模块（不依赖 Electron）
// 覆盖：建库、流程/节点/附件 CRUD、排序、搜索、回收站、导出导入、去重清理
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);
const root = path.resolve(process.argv[2] ?? '.');
const distMain = path.join(root, 'dist-main', 'main');

process.removeAllListeners('warning');

const { openDb, closeDb } = require(path.join(distMain, 'db.js'));
const svc = require(path.join(distMain, 'services.js'));
const files = require(path.join(distMain, 'files.js'));
const { exportWorkflowZip, importWorkflowZip } = require(path.join(distMain, 'transfer.js'));

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    results.push(`  OK ${name}`);
  } else {
    failed++;
    results.push(`  FAIL ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-selftest-'));
const dataDir = path.join(tmpRoot, 'HelpWorkData');

const sampleDir = path.join(tmpRoot, 'samples');
fs.mkdirSync(sampleDir, { recursive: true });
const fileA = path.join(sampleDir, '配置说明.txt');
const fileB = path.join(sampleDir, '脚本.js');
fs.writeFileSync(fileA, '这是中文内容 hello world 第一行\n第二行', 'utf8');
fs.writeFileSync(fileB, 'console.log("test");', 'utf8');

async function run() {
  // 1. 初始化
  files.ensureDirs(dataDir);
  openDb(dataDir);
  check('打开数据库并建表', fs.existsSync(path.join(dataDir, 'helpwork.db')));

  // 2. 流程 CRUD
  const w1 = svc.createWorkflow('插件制作');
  const w2 = svc.createWorkflow('日常杂务');
  check('新建流程', w1.name === '插件制作' && w2.sort_order > w1.sort_order);
  svc.renameWorkflow(w1.id, '插件制作v2');
  check('重命名流程', svc.getWorkflow(w1.id).name === '插件制作v2');
  check('流程列表', svc.listWorkflows().length === 2);

  // 3. 节点 CRUD
  const n1 = svc.createNode(w1.id, '找素材');
  const n2 = svc.createNode(w1.id, '改配置');
  const n3 = svc.createNode(w1.id, '调脚本');
  const n4 = svc.createNode(w1.id, '出文档');
  const n5 = svc.createNode(w1.id, '写说明');
  check('新建 5 个节点', svc.listNodes(w1.id).length === 5);
  svc.updateNode(n2.id, { note: '注意：\n第二行参数要改\n中文换行测试' });
  check('备注支持中文换行', svc.getNode(n2.id).note.includes('\n'));

  svc.moveNode(n5.id, -1);
  let ns = svc.listNodes(w1.id);
  check('节点上移', ns[3].id === n5.id && ns[4].id === n4.id);
  svc.moveNode(n5.id, 1);
  check('节点下移还原', svc.listNodes(w1.id)[4].id === n5.id);
  svc.reorderNodes([n5.id, n1.id, n2.id, n3.id, n4.id]);
  ns = svc.listNodes(w1.id);
  check('节点拖拽排序', ns[0].id === n5.id && ns[1].id === n1.id);

  // 4. 附件导入（哈希去重）
  const storedA = await files.storeFile(dataDir, fileA, '配置说明.txt');
  const storedA2 = await files.storeFile(dataDir, fileA, '配置说明-副本.txt');
  check('SHA256 计算', /^[0-9a-f]{64}$/.test(storedA.sha256));
  check('同内容去重复用', storedA2.stored_path === storedA.stored_path);
  svc.addAttachmentRow({ id: 'att-1', node_id: n1.id, sha256: storedA.sha256, original_name: '配置说明.txt', stored_path: storedA.stored_path, size: storedA.size, ext: 'txt', created_at: new Date().toISOString() });
  svc.addAttachmentRow({ id: 'att-2', node_id: n2.id, sha256: storedA2.sha256, original_name: '配置说明-副本.txt', stored_path: storedA2.stored_path, size: storedA2.size, ext: 'txt', created_at: new Date().toISOString() });
  const storedB = await files.storeFile(dataDir, fileB, '脚本.js');
  svc.addAttachmentRow({ id: 'att-3', node_id: n3.id, sha256: storedB.sha256, original_name: '脚本.js', stored_path: storedB.stored_path, size: storedB.size, ext: 'js', created_at: new Date().toISOString() });
  check('附件入库与列表', svc.listAttachments(n1.id).length === 1 && svc.listAttachments(n2.id).length === 1);
  check('节点附件角标数', svc.listNodes(w1.id).find((x) => x.id === n2.id).attachment_count === 1);
  const entityAbs = files.entityAbsPath(dataDir, storedA.stored_path);
  check('实体文件落盘', fs.existsSync(entityAbs));

  // 5. 搜索
  let hits = svc.search('配置');
  check('按备注关键词搜索', hits.some((h) => h.node_id === n2.id));
  hits = svc.search('脚本.js');
  check('按附件名搜索', hits.some((h) => h.node_id === n3.id));
  hits = svc.search('找素材');
  check('按节点标题搜索', hits.some((h) => h.node_id === n1.id));
  hits = svc.search('不存在的关键词xyz');
  check('无结果返回空', hits.length === 0);

  // 6. 软删除与回收站
  svc.deleteNode(n4.id);
  check('节点软删除后不显示', !svc.listNodes(w1.id).find((x) => x.id === n4.id));
  const recycle = svc.listRecycle();
  check('回收站可见被删节点', recycle.some((r) => r.kind === 'node' && r.id === n4.id));
  svc.restoreNode(n4.id);
  check('回收站还原节点', svc.listNodes(w1.id).some((x) => x.id === n4.id));

  svc.deleteWorkflow(w2.id);
  check('流程软删除', !svc.listWorkflows().find((x) => x.id === w2.id));
  svc.restoreWorkflow(w2.id);
  check('流程还原', !!svc.listWorkflows().find((x) => x.id === w2.id));

  svc.deleteNode(n1.id);
  svc.purgeAttachment('att-1');
  files.removeEntityIfUnreferenced(dataDir, storedA.sha256);
  check('同哈希仍被引用时实体保留', fs.existsSync(entityAbs));
  svc.deleteNode(n2.id);
  svc.purgeAttachment('att-2');
  files.removeEntityIfUnreferenced(dataDir, storedA2.sha256);
  check('无引用后实体清理', !fs.existsSync(entityAbs));

  // 7. 导出 / 导入
  const zipPath = exportWorkflowZip(dataDir, w1.id);
  check('导出流程 zip', fs.existsSync(zipPath) && zipPath.endsWith('.zip'));
  const dataDir2 = path.join(tmpRoot, 'HelpWorkData2');
  files.ensureDirs(dataDir2);
  closeDb();
  openDb(dataDir2);
  await importWorkflowZip(dataDir2, zipPath);
  const wNew = svc.listWorkflows().find((x) => x.name === '插件制作v2');
  check('导入流程', !!wNew, '未找到导入的流程');
  if (wNew) {
    // 导出时 n1/n2 已被软删（第 6 步），导出只含未删除的 3 个节点：调脚本/出文档/写说明（按拖拽后顺序 n5,n1,n2,n3,n4 → 剩 n5,n3,n4）
    const nsNew = svc.listNodes(wNew.id);
    check('导入节点数一致', nsNew.length === 3, `实际 ${nsNew.length}`);
    check('导入节点顺序一致', nsNew[0].title === '写说明' && nsNew[1].title === '调脚本' && nsNew[2].title === '出文档');
    const noteNode = nsNew.find((x) => x.title === '调脚本');
    const jsNode = nsNew.find((x) => x.title === '调脚本');
    const attsNew = jsNode ? svc.listAttachments(jsNode.id) : [];
    check('导入附件 SHA256 一致', attsNew.length === 1 && attsNew[0].sha256 === storedB.sha256);
    check('导入附件实体存在', attsNew.length === 1 && fs.existsSync(files.entityAbsPath(dataDir2, attsNew[0].stored_path)));
  }

  // 8. 磁盘统计
  const usage = files.diskUsage(dataDir2);
  check('磁盘占用统计', usage.files_count >= 1 && usage.db_bytes > 0);

  // ================= v2 并行分支 =================
  const br = require(path.join(distMain, 'branches.js'));
  const throws = (fn, re) => {
    try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
  };

  // 9. 创建分支
  const wb = svc.createWorkflow('分支测试');
  const t1 = svc.createNode(wb.id, '准备');
  const t2 = svc.createNode(wb.id, '分发任务');
  check('N<2 拒绝创建分支', throws(() => br.createBranches(wb.id, t2.id, ['只有一条']), /至少需要 2 条/));
  check('不存在的分叉点拒绝', throws(() => br.createBranches(wb.id, 'no-such-id', ['A', 'B']), /不存在/));
  const { branches: [bA, bB, bC], roots } = br.createBranches(wb.id, t2.id, ['前端', '后端', '文档']);
  check('创建 3 条分支各带根节点', roots.length === 3 && br.listBranches(wb.id).length === 3);
  check('根节点 parent=分叉点、branch_id 正确', roots.every((r, i) => r.parent_id === t2.id && r.branch_id === [bA, bB, bC][i].id));
  check('结构校验无环无孤儿', (() => { const v = br.validateWorkflowTree(wb.id); return v.cycles.length === 0 && v.orphans.length === 0; })());

  // 10. 分支隔离 + 门控
  const a2 = br.appendToBranch(bA.id, '前端-页面');
  br.appendToBranch(bB.id, '后端-接口');
  check('分支隔离：前端 2 步、后端 2 步、文档 1 步',
    br.branchNodes(bA.id).length === 2 && br.branchNodes(bB.id).length === 2 && br.branchNodes(bC.id).length === 1);
  let gateMsg = '';
  try { svc.createNode(wb.id, '汇总'); } catch (e) { gateMsg = e.message; }
  check('未完成时主线追加被拒绝且列出分支', /前端/.test(gateMsg) && /后端/.test(gateMsg) && /文档/.test(gateMsg), gateMsg);
  br.setBranchStatus(bA.id, 'done');
  check('标记一条完成不影响其他分支', br.getBranch(bB.id).status === 'active' && br.getBranch(bC.id).status === 'active');
  gateMsg = '';
  try { svc.createNode(wb.id, '汇总'); } catch (e) { gateMsg = e.message; }
  check('部分完成仍门控（不再列出已完成分支）', gateMsg && !/前端/.test(gateMsg) && /后端/.test(gateMsg), gateMsg);
  check('已完成分支拒绝追加', throws(() => br.appendToBranch(bA.id, 'x'), /已完成/));
  br.setBranchStatus(bA.id, 'active');
  check('取消完成可撤销并恢复追加', br.getBranch(bA.id).status === 'active' && !!br.appendToBranch(bA.id, '前端-联调'));
  br.setBranchStatus(bA.id, 'done');
  br.setBranchStatus(bB.id, 'done');
  br.setBranchStatus(bC.id, 'done');
  const t3 = svc.createNode(wb.id, '汇总');
  check('全部完成后主线恢复追加', !!t3 && t3.branch_id === null);
  check('门控信息解除', br.checkMainlineAppend(wb.id).allowed);

  // 11. 嵌套分叉（两层）+ 汇合后再分叉
  br.setBranchStatus(bA.id, 'active');
  const { branches: [nA1, nA2] } = br.createBranches(wb.id, a2.id, ['样式', '交互']);
  check('分支内节点可再分叉', br.branchesAt(a2.id).length === 2);
  check('内层未完成时外层分支追加被拒', throws(() => br.appendToBranch(bA.id, 'y'), /样式|交互/));
  check('内层门控不影响兄弟分支', br.getBranch(bB.id).status === 'done' && br.branchNodes(bC.id).length === 1);
  check('内层未完成时不能把外层标记完成', throws(() => br.setBranchStatus(bA.id, 'done'), /嵌套分支/));
  br.setBranchStatus(nA1.id, 'done');
  br.setBranchStatus(nA2.id, 'done');
  check('内层全部完成后外层分支可追加', !!br.appendToBranch(bA.id, '前端-收尾'));
  br.setBranchStatus(bA.id, 'done');
  check('已完成分支中禁止创建嵌套分支', throws(() => br.createBranches(wb.id, a2.id, ['内测A', '内测B']), /已完成/));
  const { branches: [r1, r2] } = br.createBranches(wb.id, t3.id, ['验收', '发布']);
  check('汇合后的主线可再次分叉', br.branchesAt(t3.id).length === 2);
  check('结构校验仍无环无孤儿', (() => { const v = br.validateWorkflowTree(wb.id); return v.cycles.length === 0 && v.orphans.length === 0; })());

  // 12. 环检测与孤儿防护
  check('把分支移到自身节点下被拒绝（环）', throws(() => br.moveBranch(bA.id, a2.id), /环/));
  const innerNode = br.branchNodes(nA1.id)[0];
  check('把分支移到其嵌套后代下被拒绝（环）', throws(() => br.moveBranch(bA.id, innerNode.id), /环/));
  check('跨流程移动分支被拒绝', throws(() => br.moveBranch(r2.id, svc.listNodes(wNew.id)[0].id), /其他流程/));
  br.moveBranch(r2.id, t1.id);
  check('合法移动分支成功', br.getBranch(r2.id).fork_node_id === t1.id && br.branchNodes(r2.id).every((n) => n.parent_id === t1.id));
  br.moveBranch(r2.id, t3.id);
  check('删除仍有分支的分叉点被拒绝（防孤儿）', throws(() => svc.deleteNode(t2.id), /并行分支/));
  check('嵌套分支未确认不可删除', throws(() => br.deleteBranch(bA.id), /确认/));
  check('对已删除/不存在分支继续记录被拒绝', throws(() => br.appendToBranch('no-such-branch', 'z'), /不存在或已删除/));
  check('对不存在分支标记完成被拒绝', throws(() => br.setBranchStatus('no-such-branch', 'done'), /不存在或已删除/));
  const delRes = br.deleteBranch(r1.id, { confirmedCascade: true });
  check('删除分支连同其步骤进回收站', delRes.removedNodes === 1 && br.branchesAt(t3.id).length === 1);
  const rec = svc.listRecycle();
  check('回收站出现分支条目且不散列其节点', rec.some((x) => x.kind === 'branch' && x.id === r1.id) && !rec.some((x) => x.kind === 'node' && x.name === '验收 · 开始'));
  br.restoreBranch(r1.id);
  check('回收站整体还原分支', br.branchesAt(t3.id).length === 2 && br.branchNodes(r1.id).length === 1);
  check('彻底删除分叉点被拒绝（防孤儿）', throws(() => svc.purgeNode(t3.id), /分叉点/));
  const sideNode = br.appendToBranch(r2.id, '发布-打包');
  svc.deleteNode(sideNode.id);
  br.deleteBranch(r2.id, { confirmedCascade: true });
  svc.restoreNode(sideNode.id);
  const restored = svc.getNode(sideNode.id);
  check('所属分支已删时还原节点回落主线（防孤儿）', restored && restored.branch_id === null && restored.parent_id === null);
  svc.deleteNode(sideNode.id);
  br.purgeBranch(r2.id);
  check('彻底删除分支', !svc.listRecycle().some((x) => x.id === r2.id));
  // 分支内上移/下移只影响本分支
  const frontNodes = br.branchNodes(bA.id).map((n) => n.id);
  svc.moveNode(frontNodes[2], -1);
  const after = br.branchNodes(bA.id).map((n) => n.id);
  check('分支内上移仅在本分支交换', after[1] === frontNodes[2] && after[2] === frontNodes[1]);
  check('主线顺序不受分支排序影响', svc.listNodes(wb.id).filter((n) => !n.branch_id).map((n) => n.title).join(',') === '准备,分发任务,汇总');
  const nestedDelete = br.deleteBranch(bA.id, { confirmedCascade: true });
  const nestedRecycle = svc.listRecycle();
  check('删除外层分支递归移除嵌套分支', nestedDelete.removedNodes >= 5 && !br.getBranch(nA1.id) && !br.getBranch(nA2.id));
  check('回收站只显示被删除的外层分支条目', nestedRecycle.some((x) => x.kind === 'branch' && x.id === bA.id) && !nestedRecycle.some((x) => x.kind === 'branch' && x.id === nA1.id));
  br.restoreBranch(bA.id);
  check('还原外层分支同时恢复嵌套层级', br.getBranch(nA1.id)?.status === 'done' && br.getBranch(nA2.id)?.status === 'done' && br.branchNodes(bA.id).length >= 4);

  // 13. 导出 → 导入 v2：结构、状态、嵌套完整还原
  const snap = (wid) => {
    const ns = svc.listNodes(wid);
    const bs = br.listBranches(wid);
    const byId = new Map(ns.map((n) => [n.id, n]));
    return bs.map((b) => `${byId.get(b.fork_node_id)?.title}>${b.name}:${b.status}:` +
      ns.filter((n) => n.branch_id === b.id).sort((x, y) => x.sort_order - y.sort_order).map((n) => n.title).join('|')).sort().join('\n') +
      '\n#trunk:' + ns.filter((n) => !n.branch_id).sort((x, y) => x.sort_order - y.sort_order).map((n) => n.title).join('|');
  };
  // 模拟未来版本/第三方字段，要求 v2 导入导出透传。
  const dbMod = require(path.join(distMain, 'db.js'));
  dbMod.getDb().prepare('UPDATE workflow SET extra_json = ? WHERE id = ?').run(JSON.stringify({ vendor_workflow: 'keep-me' }), wb.id);
  dbMod.getDb().prepare('UPDATE node SET extra_json = ? WHERE id = ?').run(JSON.stringify({ vendor_node: 42 }), roots[0].id);
  dbMod.getDb().prepare('UPDATE branch SET extra_json = ? WHERE id = ?').run(JSON.stringify({ vendor_branch: true }), bA.id);
  const before = snap(wb.id);
  const zipV2 = exportWorkflowZip(dataDir2, wb.id);
  const AdmZip = require(path.join(root, 'node_modules', 'adm-zip'));
  const pj = JSON.parse(new AdmZip(zipV2).readAsText('workflow.json'));
  check('含分支流程导出为 v2 且带 branches', pj.version === 2 && Array.isArray(pj.branches) && pj.branches.length === br.listBranches(wb.id).length);
  const imp = await importWorkflowZip(dataDir2, zipV2);
  check('v2 导入后分支结构/状态/嵌套一致', snap(imp.workflow_id) === before, `\n${snap(imp.workflow_id)}\n!=\n${before}`);
  const v2Round = JSON.parse(new AdmZip(exportWorkflowZip(dataDir2, imp.workflow_id)).readAsText('workflow.json'));
  check('workflow/node/branch 未知字段透传', v2Round.workflow.vendor_workflow === 'keep-me' &&
    v2Round.nodes.some((n) => n.vendor_node === 42) && v2Round.branches.some((b) => b.vendor_branch === true));
  check('v2 导入后无环无孤儿', (() => { const v = br.validateWorkflowTree(imp.workflow_id); return v.cycles.length === 0 && v.orphans.length === 0; })());
  const linZip = exportWorkflowZip(dataDir2, wNew.id);
  check('纯线性流程仍导出 v1（格式不变）', JSON.parse(new AdmZip(linZip).readAsText('workflow.json')).version === 1);

  // 14. 关闭重启后完整恢复
  closeDb();
  openDb(dataDir2);
  check('重启后分支结构/完成状态/嵌套层级完整恢复', snap(wb.id) === before);

  // 15. 旧库（schema v1）迁移：零丢失 + 迁移前备份
  closeDb();
  const { DatabaseSync } = require('node:sqlite');
  const v1Dir = path.join(tmpRoot, 'HelpWorkDataV1');
  files.ensureDirs(v1Dir);
  const raw = new DatabaseSync(path.join(v1Dir, 'helpwork.db'));
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE workflow (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE node (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE, title TEXT NOT NULL, note TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE attachment (id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE, sha256 TEXT NOT NULL, original_name TEXT NOT NULL, stored_path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, ext TEXT, created_at TEXT NOT NULL, deleted_at TEXT);
    INSERT INTO meta VALUES ('schema_version', '1'), ('last_auto_backup_date', '2026-01-01');
    INSERT INTO workflow VALUES ('wf-old', '旧流程', '旧描述', 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', NULL);
    INSERT INTO node VALUES ('n-old-1', 'wf-old', '第一步', '备注一\n第二行', 0, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', NULL);
    INSERT INTO node VALUES ('n-old-2', 'wf-old', '第二步', NULL, 1, '2025-01-01T00:00:01Z', '2025-01-01T00:00:01Z', NULL);
    INSERT INTO node VALUES ('n-old-3', 'wf-old', '回收站里的', NULL, 2, '2025-01-01T00:00:02Z', '2025-01-01T00:00:02Z', '2025-02-01T00:00:00Z');
    INSERT INTO attachment VALUES ('a-old', 'n-old-1', 'abc', '旧附件.txt', 'ab\\abc_旧附件.txt', 12, 'txt', '2025-01-01T00:00:00Z', NULL);
  `);
  raw.close();
  openDb(v1Dir);
  const oldNodes = svc.listNodes('wf-old');
  const nOld1 = svc.getNode('n-old-1');
  check('旧库迁移后记录条数不变', oldNodes.length === 2 && svc.listRecycle().some((x) => x.id === 'n-old-3'));
  check('旧库字段一个不丢', nOld1.title === '第一步' && nOld1.note === '备注一\n第二行' && nOld1.created_at === '2025-01-01T00:00:00Z' &&
    nOld1.updated_at === '2025-01-02T00:00:00Z' && svc.getWorkflow('wf-old').description === '旧描述' &&
    svc.listAttachments('n-old-1')[0]?.original_name === '旧附件.txt' && svc.getMeta('last_auto_backup_date') === '2026-01-01');
  check('旧节点视为单主干', oldNodes.every((n) => n.parent_id === null && n.branch_id === null) && br.listBranches('wf-old').length === 0);
  check('迁移前自动备份原库（带时间戳）', fs.readdirSync(path.join(v1Dir, 'backups')).some((f) => /^pre_migration_v1_to_v2_\d{8}_\d{6}\.db$/.test(f)));
  check('schema 升级到 v2', svc.getMeta('schema_version') === '2');
  const nOld4 = svc.createNode('wf-old', '第三步');
  check('旧流程线性追加照常', nOld4.sort_order === 2 && svc.listNodes('wf-old').map((n) => n.title).join(',') === '第一步,第二步,第三步');
  closeDb();
  openDb(v1Dir);
  check('旧库往返：再次加载不重复迁移/备份', svc.listNodes('wf-old').length === 3 &&
    fs.readdirSync(path.join(v1Dir, 'backups')).filter((f) => f.startsWith('pre_migration')).length === 1);

  // 16. 旧格式（v1）导出包导入 → 单主干
  const v1Zip = new AdmZip();
  v1Zip.addFile('workflow.json', Buffer.from(JSON.stringify({
    format: 'helpwork-workflow', version: 1, exported_at: '2025-01-01T00:00:00Z', custom_export_label: 'top-level-preserved',
    workflow: { id: 'x', name: 'v1 包', description: null, custom_workflow_tag: { origin: 'legacy' } },
    nodes: [
      { id: 'p1', title: '甲', note: '甲备注', sort_order: 0, attachments: [], unknown_field: '透传测试' },
      { id: 'p2', title: '乙', note: null, sort_order: 1, attachments: [] }
    ]
  }), 'utf8'));
  const v1ZipPath = path.join(tmpRoot, 'v1.zip');
  v1Zip.writeZip(v1ZipPath);
  const impV1 = await importWorkflowZip(v1Dir, v1ZipPath);
  const v1Nodes = svc.listNodes(impV1.workflow_id);
  check('v1 包导入为单主干且内容一致', v1Nodes.length === 2 && v1Nodes[0].title === '甲' && v1Nodes[0].note === '甲备注' &&
    v1Nodes.every((n) => !n.branch_id && !n.parent_id));
  const roundtripV1 = JSON.parse(new AdmZip(exportWorkflowZip(v1Dir, impV1.workflow_id)).readAsText('workflow.json'));
  check('导入导出未知字段透传', roundtripV1.custom_export_label === 'top-level-preserved' &&
    roundtripV1.workflow.custom_workflow_tag?.origin === 'legacy' && roundtripV1.nodes[0].unknown_field === '透传测试');

  closeDb();
}

run().catch((e) => {
  failed++;
  results.push(`  FAIL 异常中断：${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`);
}).finally(() => {
  try { closeDb(); } catch { /* 已关 */ }
  console.log('=== HelpWork 服务层自测 ===');
  console.log(results.join('\n'));
  console.log(`\n合计：${passed} 通过，${failed} 失败`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(failed > 0 ? 1 : 0);
});

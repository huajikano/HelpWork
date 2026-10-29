// 生成「含两层嵌套并行分支」的 v2 示例导出包到 samples\（使用临时数据目录，不碰真实数据）
// 同时把包内 workflow.json 解出一份，便于直接阅读数据结构
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
const br = require(path.join(distMain, 'branches.js'));
const files = require(path.join(distMain, 'files.js'));
const { exportWorkflowZip } = require(path.join(distMain, 'transfer.js'));
const AdmZip = require(path.join(root, 'node_modules', 'adm-zip'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-branch-sample-'));
const dataDir = path.join(tmp, 'HelpWorkData');

try {
  files.ensureDirs(dataDir);
  openDb(dataDir);

  const w = svc.createWorkflow('示例：插件发布（并行分支）', '演示两层嵌套并行分支：分叉 → 子分叉 → 汇合 → 再分叉');
  svc.createNode(w.id, '需求确认', '和需求方确认版本范围。');
  const fork1 = svc.createNode(w.id, '拆分任务', '从这里开始三条线并行推进。');

  // 第一层：3 条并行分支
  const { branches: [bUi, bApi, bDoc] } = br.createBranches(w.id, fork1.id, ['界面', '接口', '文档']);
  const uiPage = br.appendToBranch(bUi.id, '画页面');
  br.appendToBranch(bApi.id, '写接口');
  br.appendToBranch(bApi.id, '接口自测');
  br.appendToBranch(bDoc.id, '写使用说明');

  // 第二层：界面分支内再分叉 2 条
  const { branches: [bStyle, bInter] } = br.createBranches(w.id, uiPage.id, ['样式', '交互']);
  br.appendToBranch(bStyle.id, '调配色');
  br.appendToBranch(bInter.id, '加快捷键');
  br.setBranchStatus(bStyle.id, 'done');
  br.setBranchStatus(bInter.id, 'done');
  br.appendToBranch(bUi.id, '界面联调');

  // 第一层全部完成 → 主线汇合
  br.setBranchStatus(bUi.id, 'done');
  br.setBranchStatus(bApi.id, 'done');
  br.setBranchStatus(bDoc.id, 'done');
  const join = svc.createNode(w.id, '汇总验收', '三条线都完成后才能走到这一步。');

  // 汇合后再次分叉，留一条未完成，演示门控
  const { branches: [bPkg] } = br.createBranches(w.id, join.id, ['打包', '写发布说明']);
  br.setBranchStatus(bPkg.id, 'done');

  const out = exportWorkflowZip(dataDir, w.id);
  const samplesDir = path.join(root, 'samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  const dest = path.join(samplesDir, '新格式-两层嵌套并行分支_v2.zip');
  fs.copyFileSync(out, dest);
  const json = new AdmZip(dest).readAsText('workflow.json');
  fs.writeFileSync(path.join(samplesDir, '新格式-两层嵌套并行分支_v2.workflow.json'), json, 'utf8');
  closeDb();
  console.log(`v2 示例已生成：${dest}`);
} catch (e) {
  console.error(`生成失败：${e.message}`);
  process.exitCode = 1;
} finally {
  try { closeDb(); } catch { /* 已关 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// 生成示例流程导出包到 samples\（不触碰用户真实数据目录，使用系统临时目录）
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
const { exportWorkflowZip } = require(path.join(distMain, 'transfer.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-sample-'));
const dataDir = path.join(tmp, 'HelpWorkData');

try {
  files.ensureDirs(dataDir);
  openDb(dataDir);

  // 示例素材
  const sampleDir = path.join(dataDir, 'samples-src');
  fs.mkdirSync(sampleDir, { recursive: true });
  const f1 = path.join(sampleDir, '素材清单.txt');
  const f2 = path.join(sampleDir, '打包脚本.ps1');
  fs.writeFileSync(f1, '示例流程所需素材：\n1. 图标素材 3 张\n2. 配置模板 1 份\n', 'utf8');
  fs.writeFileSync(f2, '# 示例打包脚本\nWrite-Host "打包中…"\n', 'utf8');

  // 建示例流程
  const w = svc.createWorkflow('示例：插件发布流程', '一条演示用的完整工序，可导入后随意修改');
  const n1 = svc.createNode(w.id, '准备素材', '把图标、模板放进同一目录；\n注意核对版本号。');
  const n2 = svc.createNode(w.id, '修改配置', '配置文件第 12 行改成目标版本号。');
  const n3 = svc.createNode(w.id, '执行打包', '右键脚本 → 用 PowerShell 运行；\n产物在 bin\\Release 下。');
  const n4 = svc.createNode(w.id, '写发布说明', '按模板填：更新点、已知问题、下载链接。');

  const s1 = await files.storeFile(dataDir, f1, '素材清单.txt');
  const s2 = await files.storeFile(dataDir, f2, '打包脚本.ps1');
  svc.addAttachmentRow({ id: 'sample-att-1', node_id: n1.id, sha256: s1.sha256, original_name: '素材清单.txt', stored_path: s1.stored_path, size: s1.size, ext: 'txt', created_at: new Date().toISOString() });
  svc.addAttachmentRow({ id: 'sample-att-2', node_id: n2.id, sha256: s1.sha256, original_name: '配置核对清单.txt', stored_path: s1.stored_path, size: s1.size, ext: 'txt', created_at: new Date().toISOString() });
  svc.addAttachmentRow({ id: 'sample-att-3', node_id: n3.id, sha256: s2.sha256, original_name: '打包脚本.ps1', stored_path: s2.stored_path, size: s2.size, ext: 'ps1', created_at: new Date().toISOString() });
  void n4;

  const out = exportWorkflowZip(dataDir, w.id);
  const samplesDir = path.join(root, 'samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  const dest = path.join(samplesDir, path.basename(out));
  fs.copyFileSync(out, dest);
  closeDb();
  console.log(`示例流程包已生成：${dest}`);
} catch (e) {
  console.error(`生成失败：${e.message}`);
  process.exitCode = 1;
} finally {
  try { closeDb(); } catch { /* 已关 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

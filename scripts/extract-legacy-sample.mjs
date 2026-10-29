// 从提交的旧格式 v1 导出包提取可直接阅读的 workflow.json 样例。
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = path.resolve(process.argv[2] ?? '.');
const zipPath = path.join(root, 'samples', '示例：插件发布流程_20261029_145655.zip');
const outPath = path.join(root, 'samples', '旧格式-线性流程_v1.workflow.json');
const zip = new AdmZip(zipPath);
const entry = zip.getEntry('workflow.json');
if (!entry) throw new Error('旧格式样例压缩包缺少 workflow.json');
fs.writeFileSync(outPath, zip.readAsText(entry), 'utf8');
console.log(`已提取旧格式样例：${outPath}`);

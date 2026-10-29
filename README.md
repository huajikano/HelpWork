# HelpWork · 工作流节点文件管理器（Windows 单机桌面版）

把重复性工作固化成一条条「流程」，每条流程由有序节点组成，每个节点挂上做这一步真正要用的文件。文件**真正复制进数据目录**，打开流程即可按步骤直接取用，替代"去资源管理器各个角落翻找"。

- 单机单人使用，完全离线，运行期零网络请求
- 中文界面、浅色主题、绿色免安装
- 支持并行分支：一个步骤可展开多条子流程并行记录，全部分支显式标记完成后主线才继续；支持嵌套分支与完成门控

## 环境要求

- Windows 11 x64
- Node.js 22+（仅开发/打包时需要；打包后的绿色版不需要 Node）

## 快速开始（开发）

```bash
npm install        # 首次安装依赖（需要网络）
npm run dev        # 启动开发模式（Vite + Electron 热更新）
```

开发模式数据目录：项目根目录下 `HelpWorkData\`（与绿色版行为一致，便于调试）。

## 构建与打包

```bash
npm run build      # 编译主进程（tsc）+ 渲染进程（vite build）
npm start          # 用编译产物直接启动（不开 dev server）
npm run dist       # electron-builder 产出绿色版（dist\ 目录，含 zip）
```

打包产物：`dist\HelpWork-1.1.0-portable-win64.zip`，解压后双击 `HelpWork.exe` 即可使用。

## 数据目录结构

```
HelpWorkData\
  helpwork.db             # SQLite 主库（node:sqlite，WAL 模式）
  files\<sha前2位>\...     # 附件实体（按内容哈希去重）
  backups\backup_*.zip    # 备份（保留最近 7 份）
  logs\app.log            # 运行日志
  exports\                # 导出的流程包
```

当前数据目录路径记录在 `%APPDATA%\HelpWork\config.json`，可在「设置」中更改或整体迁移。

## 常用操作

| 操作 | 方式 |
|---|---|
| 新建流程 | 左栏「＋ 新建流程」 |
| 添加节点 | 中栏「＋ 添加节点」 |
| 挂文件 | 附件区拖入 / 「＋ 添加文件」 |
| 打开附件 | 双击 / 右键「打开」（系统默认程序） |
| 定位附件 | 右键「在文件夹中显示」 |
| 全局搜索 | 顶部搜索框（Ctrl+F 聚焦），点击结果跳转并高亮 |
| 回收站 | 顶栏「回收站」，支持还原 / 彻底删除 / 清空 |
| 导出流程 | 左栏流程右键「导出此流程」→ zip 保存在 `HelpWorkData\exports\` |
| 导入流程 | 设置 →「导入流程包」选择 zip |
| 备份 | 设置 →「立即备份」；每日首次启动自动备份（保留 7 份） |
| 迁移数据目录 | 设置 → 更改数据目录（可同时搬移数据） |

## 技术栈

- Electron 36（主进程，内嵌 Node 22，`node:sqlite` 内置模块——免原生编译）
- React 18 + TypeScript + Vite（渲染进程）
- adm-zip（导出/导入/备份）
- electron-builder（dir + zip 绿色版）

## 目录结构（源码）

```
src\
  main\        # 主进程：入口/IPC/数据库/文件实体/备份/导出导入/配置/日志
  preload\     # preload：contextBridge 白名单 API
  renderer\    # 渲染进程（React）：三栏界面、回收站、设置、恢复屏
  shared\      # 共享类型与 IPC 通道名
scripts\       # dev.mjs / 服务层自测 / 样例生成
docs\          # 文档（需求模型、使用说明、自测表、并行分支说明）
samples\       # 旧格式与两层嵌套分支的示例数据
build\         # 应用图标等打包资源
```

## 卸载

删除程序目录与 `%APPDATA%\HelpWork\` 即可（数据全在这两处，无注册表残留）。

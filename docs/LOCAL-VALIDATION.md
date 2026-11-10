# 本地维护版验收记录（2026-11-10）

## 范围与版本

本轮目标是验证本地 AutoCAD-only fork 能利用 DSH 内置 Python 运行，不测试天正专用对象。不升级上游、不发布 npm、不提交或推送 Git。

- 插件：本地 `D:\code\dsh-cad`，package 版本 2.0.0，基于 `f2e6ecc` 工作树修改。
- DSH：桌面版 0.2.2-rc.1，desktop profile；内置 MCP peer 0.2.2-rc.1。
- Python：DSH runtime 的 Python 3.12.14，64 位。
- 独立环境：`D:\cad\runtime\dsh-cad\venv-autocad`。
- 上游：固定 `autocad-mcp-pro 1.6.0`，应用本仓库的两组标注补丁。
- 后端：COM，ProgID `AutoCAD.Application`。
- AutoCAD：2026，运行时版本 `25.1s (LMS Tech)`。
- 现场 AutoCAD 已加载天正，但本轮仅使用普通 AutoCAD 功能。

## 安装与客户端切换

没有传 `--python`，执行：

```powershell
node bin/dsh-cad.mjs install --base "D:\cad\runtime\dsh-cad" --work "D:\cad"
```

这是一个新的插件专用环境，没有复用之前的 MCP 1.8.0 venv。安装器选中了 DSH 自带解释器，创建 venv、安装 1.6.0、应用补丁，退出 0；随后 `doctor` 全部为 OK。

默认 RuntimeOnly 未安装 SolidWorks，也未修改 Codex 配置/技能或 DSH 技能目录。CLI 按约定保存 `~/.dsh/cad.json`。

用 DSH 插件管理器安装本地目录成功：profile 记录 `dsh-cad: link:D:/code/dsh-cad`。插件条目 `include:dsh-cad` 为 active。原 `include:autocad-mcp-direct` 已禁用，没有两个写入服务并行操作同一文档。

安装器有 pnpm linked peer 警告；真实 DSH 内置 peer 已成功加载，下面的 DSH 工具调用已验证，不把单元测试中的 peer double 当作此项证据。

配置切换前备份：

- `~/.dsh/profiles/desktop/cordis.patch.before-local-dsh-cad-20261110.yml`
- `~/.dsh/profiles/desktop/package.before-local-dsh-cad-20261110.json`
- `~/.dsh/cad.before-local-plugin-test-20261110.json`

如需回退，先停用 dsh-cad，再启用原 `autocad-mcp-direct` 条目。不要把两者同时启用。不要整体恢复备份而覆盖此后用户新增的其他配置；优先使用插件管理器切换条目。

## 自动化检查

- 18 项 Node 单元测试通过，0 skip。
- Windows PowerShell 5.1 解析与只读探测测试通过。
- 3 项 Python 补丁安全回归测试通过。
- 冷安装及安装后 doctor 通过。
- pnpm pack 成功，包含新增 `.mjs`、`lib/python.ps1`、安装脚本、Skill 等运行文件。
- 从最终打包文件解包后，检查 7 个关键运行文件、执行 CLI where 和 doctor 均通过；打包后没有遗漏 Python helper 或注册模块。

单元测试不要求下载 MCP peer，显式注入 peer double；真实客户端的验证来自本次 DSH 实机调用。没有在 CI 中伪称运行了 AutoCAD。

## DSH 实机操作

以下调用通过本地插件注册的 `mcp__autocad__call_tool` 执行：

1. `system_about`：返回上游 1.6.0、active_backend=com。
2. `drawing_new(bootstrap=true)`：新建独立测试图，创建工程图层及线型。
3. 创建四条 LINE（1000 × 600 mm 矩形）和一个 CIRCLE（圆心 500,300；R100）。
4. 创建两条真正的 ROTATEDDIMENSION，横向 1000、纵向 600；没有手工传 rotation。
5. 另存 DWG，同时导出 DXF 以独立核对 DIMENSION 数据。
6. ezdxf 读回导出数据：4 LINE、1 CIRCLE、2 DIMENSION，测量值为 1000.0、600.0。
7. 关闭本次测试文档、重新打开保存的 DWG；读回 7 个实体，几何与句柄保持。
8. 获取截图。因上游 1.6.0 的高 DPI 裁切问题，另用设为 per-monitor DPI-aware 的只读 PrintWindow 捕获完整 CAD 窗口作为证据；没有修改已安装上游的截图代码。

成果（不在源码仓库内）：

- `D:\cad\autocad-test\dsh-cad-local-20261110.dwg`
- `D:\cad\autocad-test\dsh-cad-local-20261110.dxf`
- `D:\cad\autocad-test\dsh-cad-local-20261110.png`

用户原有图纸没有被本轮写入、另存或关闭。

## 已发现但未在此轮扩展修复的限制

1. 上游 1.6.0 连续导出后立即 `drawing_info` 曾出现一次 COM busy/被呼叫方拒绝；随后独立查询成功。不要盲目重试可能已写入的操作。
2. 上游 1.6.0 MCP 窗口截图在本机 150% DPI 下裁切。完整截图仅是独立诊断证据，不代表该上游问题已修复。
3. 安全策略拒绝一次 LISP 测量表达式；未启用危险模式，而是使用 DXF 独立核对尺寸。原始 LISP 不应塞进 cad_batch。
4. Codex 可选接线和旧完整 PowerShell 客户端安装分支未做实机验收；非默认路径需核对模板。默认 RuntimeOnly 不走该分支。
5. 首次自动安装仍是同步子进程，耗时下载会延长插件加载。网络较差时建议先运行 CLI install 看完整日志；后续可改异步安装及进度反馈。
6. DSH 内置 Python 被移动/删除后，依赖它的 venv 可能需要重建。不要把本机解释器绝对路径写进源码。
7. 此记录不是全部 CAD 工具、所有 AutoCAD/DSH 版本、设计规范或天正业务功能的验收。

## 后续发布建议

- 本轮保留 package 2.0.0；正式发布前选择新的版本号，不覆盖已发布同版本。
- 保留上游和 fork 原作者版权声明；核实 npm 包名是否属于维护者。
- 下一轮单独评估上游升级（例如 1.8.0）：先确认旧补丁是否应移除，再复测 schema、发现模式、命令完成状态、COM busy、DPI 截图及保存重开。
- 本地 link 安装依赖源码目录存在；改源代码后重载插件/重启 DSH，不承诺未配置 watcher 时自动更新。

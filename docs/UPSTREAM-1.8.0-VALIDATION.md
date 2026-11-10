# 上游 MCP 1.8.0 升级与本机验收（2026-11-10）

## 升级范围

升级的是 `autocad-mcp-pro`，不是 Autodesk AutoCAD 软件。GitHub 最新正式 release 与 PyPI 最新非撤回版本均核对为 **1.8.0**：

- https://github.com/U-C4N/Autocad-MCP/releases/tag/v1.8.0
- https://pypi.org/project/autocad-mcp-pro/1.8.0/

源码分支为 `autocad-only`，基线提交 `64e7616`。本轮不提交、不推送、不发布 npm，插件 package 版本仍为 2.0.0。

## 主要适配

- pin 从 1.6.0 改为 1.8.0，CLI/PowerShell/插件共享 pin。
- 搜索模式默认 6 个入口：search_tools、describe_tool、call_tool、cad_batch、drawing_info、entity_list。
- 默认 CAD_LAUNCH=never，只连接已打开的 AutoCAD；launchMode 可显式设 auto。
- 状态目录默认 `<baseDir>/state`，与源码仓库和直接存放图纸的目录分离。实测 durable、degraded=false。
- LISP_POLICY=read、危险模式关闭。保留上游 1.8 的批处理 auto 默认及错误语义，COM 回滚仍是 best-effort UNDO。
- 启动健康检查除了包版本/核心模块，也执行只读维度兼容检查，避免 pip 重装后补丁丢失而误判健康。
- 随包 Skill、配置示例、README 与测试已按新版更新。

## 不能假定新版已经包含旧修复

实际检查 PyPI 1.8.0 源码发现：线性标注仍默认 rotation=0.0，角度标注未暴露 minor_angle。不能只因为版本变新就删除本插件的兼容修复。

补丁工具现在读取 `--base` 下目标环境的 distribution METADATA，不使用脚本解释器的包版本。只支持经过核对的精确 1.6.0 / 1.8.0；缺失、重复、异常、未知元数据拒绝。

1.8.0 的 ComBackend 增加 ComCheckpoints 基类，因此有单独的 helper 插入锚点。两个文件的全部锚点必须唯一匹配，拟修改源码必须通过 AST 能力检查后才写入；能力已完整时只读返回成功。15 项回归覆盖版本选择、未知版本、缺文件、漂移、重复锚点、部分能力、幂等以及旧 1.6.0 回退。

这仍然是**本插件的兼容补丁**，不是声称上游原生已修复；未来 release 必须重新核对，不允许使用宽泛 `>=1.8` 跳过。

## 独立环境与回退保留

- 旧 1.6.0 环境：`D:\cad\runtime\dsh-cad\venv-autocad`，未覆盖或删除。
- 新 1.8.0 环境：`D:\cad\runtime\dsh-cad-1.8.0\venv-autocad`。
- 基础 Python：DSH 内置 Python 3.12.14，64 位；依赖安装在独立 venv，不混装 DSH 自带环境。
- 新状态数据库：`D:\cad\runtime\dsh-cad-1.8.0\state\journal.sqlite3`。
- 配置备份：`~/.dsh/cad.before-mcp-1.8.0-20261110.json`。
- profile 备份：`~/.dsh/profiles/desktop/cordis.patch.before-mcp-1.8.0-20261110.yml`。

安装/切换前先停用 dsh-cad。新环境安装并通过兼容检查后，用 CLI 保存新 baseDir，再启用插件；旧直连条目继续停用，只有一个 autocad 命名空间在使用。

回退需要**匹配旧代码 pin 和旧环境**，不是只把新代码的 cad.json 指回 1.6.0。可先停用插件，使用提交 64e7616 对应的旧插件代码或之前保留的安装包，再恢复旧 cad.json；保护此后用户新增的 profile 配置，不整体覆盖。旧环境与旧测试图均保留。

## 自动化与打包验收

- Node 单元测试：20 项通过，0 skip。
- PowerShell 5.1 解析、解释器发现、固定版本与安全目标检查通过。
- Python 补丁回归：15 项通过。
- 新环境 CLI install、doctor、补丁只读 check 均通过。
- 运行时 `system_about`：version=1.8.0、active_backend=com、257 registered、252 enabled。
- 运行时 `system_status`：connected=true、cad_launch=never、state_store.mode=durable、degraded=false。
- 最终安装包解包后执行 where / doctor，确认固定版本和必需运行文件。

## AutoCAD 2026 实机验收

现场版本：AutoCAD `25.1s (LMS Tech)`，DSH 0.2.2-rc.1。当前 AutoCAD 虽已加载天正，但只测试普通 CAD 操作。

所有写入都在本轮新建测试图内完成：

1. 新建图纸、bootstrap 工程图层和线型。
2. dry-run 检查 8 个创建操作，再带 expected_revision=14 执行，8 项均成功。
3. 四条绿色 LINE 组成 1200 × 800 mm 矩形；红色 CIRCLE 圆心(600,400)、R150。
4. 不显式传 rotation 创建横/竖两个线性标注；创建射线输入顺序本会形成 330° 扫角的角度标注，minor_angle=true。
5. 保存 DWG、导出 DXF。此次 Document.Export 保持活动 DWG 不被改指向 DXF（repointed=false）；紧接着 drawing_info 也成功，没有复现旧基线的 COM busy。
6. 用 ezdxf 独立读取导出数据：8 个实体，线性测量 1200.0 / 800.0，角度测量 29.99999999999996°。
7. 关闭并重开本轮 DWG；读回 8 个实体及原句柄，document_id/revision 与 lineage 连续。
8. 原生 MCP 截图在本机 150% / 144 DPI 下返回完整窗口，capture=2570×1462、dpi_awareness=per_monitor；无需外部截图补救。
9. 新版预检负向测试：批处理含创建圆和不存在的 FFFFFFFF 句柄删除操作，整批在执行前被拒绝；随后 entity_count 仍为 8，没有多余圆。

成果在源码仓库之外：

- `D:\cad\autocad-test\dsh-cad-upstream-1.8.0-20261110.dwg`
- `D:\cad\autocad-test\dsh-cad-upstream-1.8.0-20261110.dxf`
- `D:\cad\autocad-test\dsh-cad-upstream-1.8.0-20261110.png`

## 边界

- 这是基础控制和本次迁移的专项验收，不是全部 252 个工具、所有版本、天正业务对象或设计规范的验收。
- 一次连续导出后查询成功，不能据此保证所有 COM busy 情况都消失；仍应依据错误语义与读回结果判断重试。
- 1.8.0 COM 回滚不是绝对原子事务；应阅读 atomicity 和验证结果。
- 原生截图此次在本机缩放设置下通过，不保证所有显卡/窗口状态都相同。
- 首次自动安装仍同步等待，网络差时先 CLI install 查看日志。
- 如正式发布，请另定插件版本号、核对包名及版权，再执行测试、打包和实际客户端验收。

# dsh-cad

Windows 上的 **DSH → AutoCAD** 连接插件。本项目由 [27painter/dsh-sw-cad](https://github.com/27painter/dsh-sw-cad) 分离而来，仅保留 AutoCAD，不安装 SolidWorks 环境。

```text
DSH agent → DSH 原生 MCP 客户端 → autocad-mcp-pro → Windows COM → AutoCAD
```

真正的绘图工具来自 [U-C4N/Autocad-MCP](https://github.com/U-C4N/Autocad-MCP)。本插件负责解释器发现、独立环境、固定版本安装、配置和客户端注册，不复制上游工具实现。

## Python：通常不用另装

支持复用 DSH 桌面版自带的 Python，**仅用它创建独立 venv**；CAD 依赖不会装进 DSH 自带 Python。

自动发现顺序：

1. 显式 `--python` / PowerShell `-Python`。
2. `CAD_PYTHON` 环境变量；JS 入口也支持配置文件中保存的绝对 Python 路径。
3. DSH 数据目录内的 `dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`，然后其他 runtime。
4. 可用的环境/PATH 解释器。

`DSH_HOME` 可覆盖默认的 `~/.dsh`。WindowsApps 商店别名会被跳过；解释器须满足 Python ≥3.11，具备创建 venv 与安装 pip 的能力。显式指定一个无效路径会报错，不会偷偷切换到另一套 Python。

DSH 内置 Python 在本机已实际验证能创建独立环境；其他 DSH 分发版本仍应先检查，不保证所有嵌入式 Python 都具备相同能力。

## 前提

- Windows 10/11，已安装且已授权 AutoCAD。
- DSH（本次测试宿主为 0.2.2-rc.1）或可配置 MCP 的客户端。
- Node.js ≥20 用于 CLI；DSH 插件入口使用宿主 Node，不要求系统 PATH 另有 Node。
- 首次准备环境需要访问 PyPI。正常使用不需要访问 GitHub 下载 SolidWorks 项目。
- DSH 与 AutoCAD 使用相同 Windows 用户、相同权限级别，推荐都普通启动。

## 从本地源码安装到 DSH

在 DSH 插件管理器中安装本地项目目录，或在 `dsh` 命令可用时运行：

```powershell
dsh plugin --profile desktop add "D:\code\dsh-cad"
```

`desktop` 应换成你实际使用的 profile。不要直接覆盖 profile 的 `node_modules`。

**先停用其他同名 `autocad` MCP 连接**（例如直连条目、dsh-sw-cad 或另一个桥），避免命名空间冲突。安装失败时保留原配置以便回退。

本插件通过 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 接线。它不是 Python MCP 本身，也不需要额外安装另一个 CAD 桥。

### 首次加载

默认缺运行环境时，插件自动创建独立 venv、安装固定上游版本和本包所需补丁，然后注册一个 `autocad` MCP 服务。

**插件及 CLI 的默认自动安装是 RuntimeOnly：不修改 DSH profile/skills、不修改 Codex 配置/skills。** DSH profile 中的插件注册由插件管理器负责。工作文件目录按需建立。

用 `CAD_NO_AUTO_INSTALL=1` 可禁止自动安装，缺环境时明确报错。

## 先手动准备运行环境（便于看日志）

从项目目录执行（`node` 可替换为 DSH 自带 Node 的绝对路径）：

```powershell
node bin/dsh-cad.mjs where
node bin/dsh-cad.mjs install --base "D:\cad-agents" --work "D:\cad"
node bin/dsh-cad.mjs doctor
```

不必传 `--python`；`where` 会打印实际选中的解释器及来源。安装成功后路径配置保存到 `DSH_HOME/cad.json`。

只使用 PowerShell、不依赖 PATH 中的 Node，也可以：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -RuntimeOnly -BaseDir "D:\cad-agents" -WorkDir "D:\cad"
```

直接执行 PowerShell 脚本不会替 CLI 保存 `cad.json`；请让插件使用相同的 `baseDir` / `workDir` 配置，或使用默认路径。

显式解释器示例：

```powershell
node bin/dsh-cad.mjs install --python "E:\Python312\python.exe" --base "D:\cad-agents" --work "D:\cad"
```

`--force` 会删除并重建插件自己的 `venv-autocad`；不要在服务运行时使用。脚本会校验删除目标，并拒绝将 junction/symlink 当作 venv 删除。

## 配置

用户路径配置：`DSH_HOME/cad.json`，默认 `~/.dsh/cad.json`：

```json
{
  "baseDir": "D:\\cad-agents",
  "workDir": "D:\\cad",
  "backend": "com",
  "progId": "AutoCAD.Application.25.1",
  "launchMode": "never"
}
```

`python` 可以省略以自动发现，也可以填一个解释器绝对路径。CLI 的 `--python` 优先于旧配置。插件条目还可通过 `config` 提供同名选项。

- `baseDir`：专用环境和 pip 缓存；venv 位于其 `venv-autocad` 子目录。
- `workDir`：图纸允许访问的目录及子目录，同时作为 MCP 工作目录。
- `backend`：默认 `com`，避免连接失败后把后台 DXF 当成实控 AutoCAD；若要显式无头模式，需自行评估并配置。
- `progId`：默认 `AutoCAD.Application`；按本机注册情况可指定版本化 ProgID。
- `launchMode`：默认 `never`，只连接已启动的 AutoCAD；需自动启动时显式设为 `auto`。可通过 `CAD_LAUNCH` 覆盖。
- `stateDir`：默认 `<baseDir>/state`，保存上游 1.8 的操作日志和检查点；必须独立于源码仓库和直接存放图纸的目录。可通过 `CAD_STATE_DIR` 覆盖。
- `CAD_BASE`、`CAD_WORK_DIR`、`CAD_PYTHON`：可通过环境变量覆盖。
- `CAD_DISABLE=autocad`：禁用，且不会触发自动安装。
- `CAD_ASSUME=autocad`：仅在注册表探测不准时强制注册；不能替代实际的 COM 连接能力。

同一 `autocad` 命名空间只能有一个连接。所有默认写入都针对当前绑定文档，正式图纸先备份；切换活动文档后应重新确认目标。

## 上游版本与补丁

当前固定版本以 `lib/upstream.json` 为唯一默认来源：**autocad-mcp-pro 1.8.0**（2026-11-10 核对的 [GitHub 最新正式版](https://github.com/U-C4N/Autocad-MCP/releases/tag/v1.8.0) 与 [PyPI 版本](https://pypi.org/project/autocad-mcp-pro/1.8.0/)一致）。不是无约束地安装以后发布的 latest。

插件会核对实际已安装版本和核心模块，不再只凭 `autocad-mcp.exe` 文件存在判断就绪。升级 pin 时必须重新验证：MCP 握手、工具参数、默认行为、COM 实机和补丁。

`patches/apply_patches.py` 根据**目标环境元数据的精确版本**选择修复/验证路径，不使用脚本自身所在环境的包版本冒充目标版本。实际检查发现 PyPI 1.8.0 仍未包含本插件所需的竖向线性/角度标注修复，因此保留经过 1.8.0 锚点和行为检查的兼容补丁；不能因版本号较新就假定已修复。未知版本、缺目标、漂移和半应用状态均需明确处理，详见 `patches/README.md`。

1.8.0 使用 `DISCOVERY_MODE=search`，默认列出 6 个入口：`search_tools`、`describe_tool`、`call_tool`、`cad_batch`、`drawing_info`、`entity_list`。`TOOL_PROFILE=full`、`TOOL_PACKS=all` 保留全部可搜索工具；实际数量以 `system_about` 为准，不承诺跨版本固定 token 数。

### 从 1.6.0 迁移

先备份 `cad.json` 并停用插件，再在**新 baseDir** 安装，避免覆盖正在运行的旧 venv：

```powershell
node bin/dsh-cad.mjs install --base "D:\cad-agents-1.8.0" --work "D:\cad"
node bin/dsh-cad.mjs doctor
```

成功后重载/启用插件，核对 `system_about` 是 1.8.0、后端为 COM，并在新图验收保存重开。保留旧环境；仅把 cad.json 指回 1.6.0 不够，回退还需匹配旧插件 pin/配置，或启用独立的已验证旧连接。

需要注意的新版默认行为：

- 写入 `cad_batch` 默认 `on_error=auto`，COM 回滚仍是 best-effort UNDO，不是绝对原子；读取 `atomicity`。需要旧的保留前序步骤行为时显式 `on_error=stop`。
- `LISP_POLICY=read`，危险模式保持关闭；不要为了绕过拒绝关闭策略。
- 命令通道会等待完成并可能返回 `command_incomplete`，不是简单的“已发送”。
- 持久化日志放在独立 `stateDir`，检查 `system_status` 的状态存储是否降级。
- 详细迁移和本机验收记录见 `docs/UPSTREAM-1.8.0-VALIDATION.md`；旧 1.6.0 记录保留作历史基线。

## CLI

| 命令 | 作用 |
|---|---|
| `node bin/dsh-cad.mjs where` | 路径、Python 来源 |
| `node bin/dsh-cad.mjs install` | 默认只准备运行时，保存 cad.json |
| `node bin/dsh-cad.mjs doctor` | 只读检查，不安装；缺失/不匹配时退出 1 |
| `node bin/dsh-cad.mjs serve autocad` | stdio MCP 服务；不要向 stdin 手动输入自然语言 |
| `node bin/dsh-cad.mjs version` | 插件版本，不是上游 MCP 版本 |

CLI 的 `--with-dsh-patch` / `--with-codex` 是显式客户端配置选项，不是默认安装流程。旧的完整 PowerShell 安装路径仍保留；涉及 Codex 时必须核对并调整模板中的绝对路径，本轮不对该路径做实机验收。

Skill 随包提供，但 RuntimeOnly 不会修改技能目录。基础 MCP 控制不依赖 Skill；如需额外指导，使用客户端自己的技能安装方式。

## 开发与测试

```powershell
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/powershell.test.ps1
python test/patches.test.py
npm pack --dry-run
```

- Node 单元测试显式注入 peer double，覆盖 Python 发现、优先级、商店别名、环境版本校验、禁用无副作用及 RuntimeOnly 注册逻辑；不会因缺 peer 而跳过假绿。
- PowerShell 测试覆盖 5.1 语法、解释器发现、显式路径、pin 和危险删除目标拒绝，不实际安装或修改 profile。
- Python 测试只修改临时补丁样本，覆盖半应用、缺文件、漂移、dry-run、幂等。
- 这些不是 AutoCAD 集成测试。真实 DSH peer、MCP 握手及 AutoCAD 必须单独验收。

建议每个发布版本在**新建测试图**中完成：新建 → 画图元 → 读回坐标/尺寸 → 保存 DWG → 关闭重开 → 截图；记录插件版本、上游版本、Python、DSH、AutoCAD 和已知限制。

## 排障

| 现象 | 检查 |
|---|---|
| 找不到 Python | `where` 输出；DSH runtime 是否包含 venv/pip；显式 CAD_PYTHON 是否过期 |
| 安装超时 | 区分插件下载、PyPI 依赖下载、MCP 启动，不盲目增加全部超时 |
| MCP 工具没出现 | 插件状态/日志、peer 兼容、是否存在另一个 autocad 连接 |
| 不能操作 AutoCAD | CAD 已启动、没有模态弹窗、同用户同权限、ProgID 正确、backend=com |
| 文件访问被拒绝 | 输出路径是否在 workDir 范围内 |
| 补丁漂移 | 核对 pin 与上游，不直接忽略或强制替换 |

## 许可证与来源

MIT，保留原项目和上游的版权声明；见 LICENSE。本插件不重新分发上游 MCP 实现。后续维护仓库：[echogyf/dsh-cad](https://github.com/echogyf/dsh-cad)。

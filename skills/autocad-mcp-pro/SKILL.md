---
name: autocad-mcp-pro
description: "AutoCAD 制图自动化：绘制/修改 DWG、DXF，图层、标注、图块、布局、建筑平面、机械图和 P&ID，以及图纸分析和导出。通过 autocad MCP 按需发现工具并执行；本插件固定上游 1.8.0，COM 在 AutoCAD 2026 做本机验收，其他版本需要单独验证。"
metadata: { "os": ["win32"] }
---

# AutoCAD 自动化技能

使用本插件注册的 `autocad` MCP。不要要求系统 PATH 另有 Python，也不要往 DSH 自带 Python 安装 CAD 依赖；运行环境由插件独立 venv 管理。

## 预检

1. 先打开 AutoCAD，完成许可提示、关闭模态弹窗；插件默认 `CAD_LAUNCH=never`，不自动启动另一实例。
2. DSH 和 AutoCAD 同 Windows 用户、同权限，推荐都普通启动。
3. 用 `system_about`、`drawing_info` 确认上游版本、COM 后端、当前绑定文档；不要把无头 DXF 当成实控。
4. 文件必须位于插件配置的 `workDir` / `ALLOWED_PATHS` 内，不把 `D:\AutoCad` 当成所有机器的固定路径。
5. 修改已有图纸前先另存副本；活动文档改变时先确认目标，不盲目重试写操作。

## 工具发现（上游 1.8.0）

默认列出 6 个工具：`search_tools`、`describe_tool`、`call_tool`、`cad_batch`、`drawing_info`、`entity_list`。默认启用 252 个可搜索业务工具，完整注册数为 257（5 个 3D 工具需显式启用）；实际以 `system_about` 为准。

- 用 `search_tools` 搜索命令、任务关键词，不凭记忆猜参数。
- 用 `describe_tool` 获取完整 schema。`name` 和 `names` **只传其中一个**，不要同时传空字符串/空数组；它是合成发现工具，不可通过 `call_tool` 代理。
- 使用平铺参数，例如 `call_tool(name="entity_create_line", arguments={"x1":0,"y1":0,"x2":100,"y2":0})`。
- 工具坐标遵循其 schema，通用二维操作使用 WCS；不要把屏幕像素直接当图纸坐标。
- `TOOL_PROFILE=full`、`TOOL_PACKS=all` 保留完整搜索目录；发现模式仅收缩常驻入口。

## 工作流

1. 明确单位、尺寸、图层、图框、比例、输出格式；信息不足先确认。
2. 工程图可用 `drawing_new` 自动准备工程图层/线型。普通连接测试可关闭 bootstrap；不要修改用户原有图纸验证连接。
3. 优先使用类型化工具：几何、真实 DIMENSION、图块属性、文字、布局、页面设置；不要用文字加线冒充尺寸。
4. 参数化齿轮、键槽等优先用上游生成器；图框和标题栏优先用相应工具。具体规范适用性仍需核实，不能把 ISO 模板当成所有专业的标准。
5. 批量操作先 `cad_batch(dry_run=true)`。需要并发保护时携带预览的 revision/实体条件。
6. 上游 1.8.0 的写入批处理默认 `on_error=auto`；实时 COM 回滚是 best-effort UNDO，**不是绝对原子事务**，读 `atomicity` 和验证结果。原始 command/LISP 不得塞入批处理。
7. 上游失败可能返回 `kind/category/retryable/hint/operation_id`。只对明确可重试、且没有不确定写入的错误重试；`requires_reconcile`、未知提交状态或半成品必须先读回。
8. 读回实体与测量值、截图，再保存。正式工程交付按上游要求执行 critique / finalize / verification；明确列出未检查项，不把评分当建筑规范审查。
9. 关闭并重开本次保存的测试/交付副本，核对实体、尺寸和文件格式；PDF 另核幅面。成功返回不等于交付已验证。

## 能力索引（以搜索结果为准）

- 文档：`drawing_new/open/save/save_as`、`document_list/activate`。
- 几何/编辑：`entity_create_*`、`entity_edit_geometry`、`entity_move/copy/rotate/scale/mirror/offset`、修剪/延伸/倒角/圆角。
- 批量整理：`entity_modify_where`、`layer_rename/merge`、`entity_delete_many`，先 dry-run。
- 标注：`dimension_linear/aligned/angular/radius/diameter`、`dimension_auto`、样式工具。
- 布局出图：`layout_*`、`viewport_*`、`page_setup_apply`、`batch_plot`、导出工具。
- 建筑：`arch_*` 提供上游自己的平面数据，不因此成为天正原生对象。
- 专业工具：`mech_*`、`pid_*`、图框/明细表/算量，先核实适用范围。
- 历史/恢复：`checkpoint_*`、`drawing_history`、`transaction_*`。COM 检查点恢复通常打开新文档，不支持直接替换活动数据库。

## 原生命令、LISP 与边界

- 优先类型化工具。`system_run_command` 会等待命令状态，但仍需验证结果；未完成可能返回 `command_incomplete`。
- `LISP_POLICY=read`、危险模式关闭。不要因为表达式被拒绝就关闭安全策略或绕过限制。
- 没有 COM 方法的能力应如实说明，不能静默切到无头模式修改原始 DWG。某些无头工具可用于单独副本，必须说明后端与对象损失风险。
- 3D、BIM/Revit、CAM、天正业务对象并非本轮基础连接验收范围。
- 上游已报告的工具限制、软件弹窗、非原子回滚仍然存在；不能凭工具数量或测试总数宣称全部可用。

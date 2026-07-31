# GOAL-06：Verification、视觉与人工证据

## 目标

实现 reviewedHead 隔离验证、受控视觉 Evidence 能力和人工 attestation 导入，使命令退出事实和人工观察都通过 Evidence Store 进入后续 Review。

对应 SPEC §5.2～§5.4、§10.4～§10.7、§15.4、§17.1、AC-005、AC-006、AC-011，以及 §22 第 5 步的后半部分。

## 前置条件

- GOAL-05 已完成。
- Sandbox、Command Policy、Evidence Store 和 Plan command catalog 可用。

## 必读

- SPEC §5、§6.3、§10、§15.4、§17.1、§18。
- 沙箱/网络/批准 ADR。
- 当前仓库根 `AGENTS.md` 的界面测试限制。
- GOAL-04/05 交接契约。

## 范围

### 1. VerificationPort

Verification 必须：

1. 以 reviewedHead 创建隔离工作区。
2. 按 Plan 的 workspaceProvision 准备依赖。
3. 校验 command ID 和 criterion 关联。
4. 通过 CommandPolicyPort。
5. 通过 SandboxPort 启动。
6. 使用 argv、`shell: false`、隐藏窗口和明确 timeout。
7. 有界收集并脱敏 stdout/stderr。
8. 记录真实退出事实。
9. 创建 command Evidence。
10. 确认进程树退出并销毁工作区。

不得在 Run 工作树执行命令，不得根据模型描述改写 exitCode，不得自动重试。

### 2. workspaceProvision

实现：

- 允许从 Run 工作区硬链接或复制 Plan 声明的依赖目录。
- 防止链接逃逸、写回源目录和未声明同步。
- 需要网络安装时只允许已登记命令 ID 并要求策略/用户批准。
- 未声明 provision 导致依赖缺失时记录真实失败。
- provision 本身也受 timeout、网络、环境和进程树限制。

### 3. verification request

提供应用层能力处理 Reviewer 将来返回的结构化请求：

- 优先引用 Plan command catalog。
- 新命令只能引用受控 tool ID。
- 需要新增权限时进入用户输入恢复点。
- 采集完成后产生可供新 Review Session 使用的 Evidence 索引。
- 历史无结论 Review 事实不覆盖。

本 Goal 不实现 Reviewer 循环，只实现确定性验证能力。

### 4. VisualEvidencePort

端口至少表达：

- reviewedHead。
- 启动命令/受控 tool ID。
- 视口、DPR、数据条件。
- image、measurement 和可选 ocr。
- 生成过程的网络、环境、timeout 和 Artifact。

实现必须遵守：

- 只驱动系统已安装浏览器，不下载浏览器。
- 无 postinstall、原生扩展或禁用依赖。
- OCR 只能使用通过门禁的纯 JS/WASM。
- OCR 不可安全实现时明确省略该能力，不伪造 ocr。
- 目标仓库禁止自动浏览器测试时不得启动浏览器或服务器。
- 当前仓库实施验证不得违反根 `AGENTS.md`；浏览器界面由用户自行测试。

### 5. 人工 attestation

实现严格输入 Schema 和 Application Use Case：

- 校验 run/task/criterion/reviewedHead 当前匹配。
- verdict 只允许 satisfied/not_satisfied。
- 系统生成 ID、时间、producer。
- 安全复制并校验 Artifact。
- 创建 manual_attestation Evidence。
- 导入不直接改变 Task。
- 导入成功后仍需用户执行 resume。
- 不匹配或缺失时保持 `MANUAL_VERIFICATION_REQUIRED`。

CLI 解析和帮助文本可在 GOAL-12 集中接线，但本 Goal 必须提供完整、可测试的命令用例接口。

### 6. 禁止伪证据

代码和测试必须拒绝把以下事实单独解释为满足：

- 模型“目视通过”。
- 对象、测试、代码行或亮色像素数量。
- 源码字符串存在。
- 已删除临时脚本。
- 历史 Run 或参考项目结论。
- 其他 Head 的 Evidence。

## 明确不在范围

- 不实现 Task Reviewer 决策。
- 不实现 Final Review。
- 不根据当前输出反向设置视觉阈值。
- 不自动修改已接受 Plan 的 Evidence Policy。

## 测试

必须覆盖：

- 命令成功、失败、启动失败、timeout、截断和脱敏。
- 模型声称成功但真实命令失败。
- command policy deny/approval。
- workspaceProvision 复制、硬链接、网络批准和逃逸。
- reviewedHead 工作区与 Run 工作树隔离。
- 进程树和工作区清理。
- VisualEvidencePort 的条件记录和能力缺失。
- 禁止自动浏览器时返回人工证据恢复点。
- attestation 有效、Head/ID 不匹配、Artifact 不安全、预算超限。
- attestation 导入后 Task 状态不直接变化。

## 完成定义

- Verification 事实完全来自系统执行。
- command Evidence 包含 SPEC 要求的全部审计字段。
- 视觉能力缺失不会静默降级或伪造 Evidence。
- 人工 Evidence 只能由 Session 外显式导入。
- 所有命令受 Sandbox 和 Command Policy。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-07

交接必须列明：

- Task criterion 在 Review 前如何请求计划命令。
- Verification 执行和 Evidence 索引 API。
- `MANUAL_VERIFICATION_REQUIRED` 恢复点。
- VisualEvidence 能力发现事实。


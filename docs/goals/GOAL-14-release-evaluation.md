# GOAL-14：真实模型评估与发布闭包

## 目标

运行独立于 `npm test` 的真实模型评估，建立首次发布基线，并逐条审计 AC-001～AC-015 和 SPEC §23；只有全部通过后才宣布本 SPEC 实现完成。

对应 SPEC §20.3、§21、§23 和 §22 第 11 步。

## 前置条件

- GOAL-13 已完成。
- `npm test` 全绿。
- 真实评估 ADR、评估集和 harness 已版本化。
- 用户已明确批准真实模型调用、凭据使用、成本和预计时间。

## 必读

- 完整 SPEC。
- SPEC §20.3、§21、§23。
- 真实评估 ADR。
- `docs/implementation/requirement-ledger.md`。
- `docs/implementation/automated-acceptance.md`。
- GOAL-13 交接。

## 阻断规则

缺少以下任一条件时，本 Goal 必须标记 blocked，不能用 Fake Claude 代替：

- 可用的真实 Claude CLI 和认证。
- 用户对成本、Token 和运行时间的明确批准。
- 版本化评估集。
- 固定 trial 规则。
- 可保存且经过脱敏的结果目录。
- 安全 Sandbox 和命令策略。

## 范围

### 1. 固化评估输入

记录：

- 评估集版本和哈希。
- 模型、Claude CLI、ApexCodingAgent、Prompt、policy 版本。
- 系统环境和 Node/Windows 版本。
- trial 数量、随机性设置和预算。
- false accept/false reject 的判定规则。
- 完成率和 Invalidation 放大率算法。

运行前不得根据预期结果临时修改阈值。

### 2. 运行真实失败案例和对抗样本

至少覆盖：

- china-3d 三类核心假阳性。
- 不可读视觉目标。
- 间接像素/数量伪证据。
- Final Review 启动失败。
- prompt injection。
- 权限扩大请求。
- 命令失败与模型成功自述冲突。
- 后续变更导致历史结论失效。
- user input/manual attestation 恢复。
- 基础设施错误与产品不通过区分。

每个场景按 ADR 的 trial 规则重复执行。

### 3. 采集指标

必须记录：

- false accept。
- false reject。
- 完成率。
- 平均 Candidate、Review、Session。
- 时间、Token 和可用时的成本。
- injection/权限/恢复表现。
- Invalidation 放大率。

外部文本和 Artifact 遵守 Redaction/Evidence 预算。

### 4. 建立首次基线

新增版本化基线文件，至少包含：

- 评估集版本。
- 模型/CLI/Prompt/policy 版本。
- 样本和 trial 总数。
- 指标。
- 发布阈值。
- 生成时间和运行 Evidence 索引。

发布要求：

- china-3d 三类核心假阳性 false accept 为 0。
- 整体 false accept 不高于基线。
- 完成率不低于基线。

首次基线的比较语义必须遵守 GOAL-00 ADR，不能用“本次结果等于本次基线”形成循环自证。

### 5. 失败处理

评估失败时：

- 不放宽阈值。
- 不删除困难样本。
- 不在本 Goal 直接做无归属 patch。
- 将失败映射到 requirement ID 和 owner Goal。
- 重新打开对应 Goal，修复并从其后续依赖阶段重新验证。

模型或 Prompt 实质变化后必须重跑。

### 6. 最终逐条审计

检查：

- requirement ledger 无 pending/in_progress/blocked。
- AC-001～AC-015 均有自动化或真实/人工 Evidence。
- §23 八项全部满足。
- `npm test` 全绿。
- 安全、崩溃恢复、长 Prompt 和完整 E2E 通过。
- 真实评估达到基线。
- 无兼容、迁移、fallback、deprecated、双重完成判断、隐式权限扩大或模型自证。
- README、help、Schema、报告和实现一致。

### 7. 发布闭包报告

新增 `docs/implementation/release-closure.md`：

- 最终 Git HEAD。
- 所有 Goal 完成提交。
- AC Evidence。
- §23 Evidence。
- 自动化测试命令和结果。
- 真实评估版本、结果和基线。
- 已知非阻断限制。
- 用户需执行的合并/发布步骤。

## 明确不在范围

- 不自动发布 npm。
- 不 push、merge、部署或修改生产数据。
- 不在评估后自动放宽标准。
- 不把首次基线当作绕过质量门槛的工具。

## 完成定义

- 真实模型评估按固定协议完成并达到发布门槛。
- china-3d 三类 false accept 为 0。
- AC-001～AC-015 全部闭合。
- SPEC §23 全部闭合。
- requirement ledger 全部为 completed。
- `release-closure.md` 可独立复核。
- `npm test` 最终全绿。
- `STATUS.md` 中 GOAL-00～GOAL-14 全部 completed。

只有此时，才允许对用户声明“`docs/SPEC.md` 已完整实现”。


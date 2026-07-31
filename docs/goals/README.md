# ApexCodingAgent 线性实施 Goals

本目录把 `docs/SPEC.md` 的全量重构拆分为可在不同会话中线性执行的 Goal。

这些文档只负责组织实施，不替代规格。任何冲突都以 `docs/SPEC.md` 为准；Goal 文档不得被解释为降低、删除或改写 SPEC 要求。

## 1. 使用方式

每个新会话必须按以下顺序读取：

1. 仓库根目录的 `AGENTS.md` 指令。
2. 完整 `docs/SPEC.md`。
3. 本文件。
4. `docs/goals/STATUS.md`。
5. `docs/goals/TRACEABILITY.md`。
6. 当前 Goal 文档。
7. 当前 Goal 列出的前置交接产物。

不得依赖此前会话的聊天记录、摘要或隐式记忆。跨会话事实只允许来自 Git、仓库文件、测试结果和已持久化的实施文档。

## 2. 权威层级

实施时采用以下权威顺序：

1. 用户在当前会话中的显式决定。
2. `docs/SPEC.md`。
3. 根目录 `AGENTS.md`。
4. `docs/implementation/requirement-ledger.md` 中对 SPEC 条款的逐条索引。
5. 已批准的架构决策记录。
6. 当前 Goal 文档。
7. 历史会话交接摘要。

架构决策记录只能解释实现选择，不得覆盖 SPEC。若发现必须修改 SPEC 才能继续，当前 Goal 必须停止并请求用户决定。

## 3. 线性顺序

| 顺序 | Goal | 结果 |
|---|---|---|
| 00 | [规格闭包与实施基线](./GOAL-00-spec-closure.md) | 逐条需求账本、高风险 ADR、可执行架构蓝图 |
| 01 | [编排阶段边界重构](./GOAL-01-orchestration-boundaries.md) | 小型 Run Driver、显式阶段边界、无巨型 Use Case |
| 02 | [单一状态聚合与幂等协调](./GOAL-02-state-and-recovery.md) | `state.json`、immutable stores、operation 恢复协议 |
| 03 | [Plan 与核心领域模型](./GOAL-03-plan-domain.md) | Plan、Trace、Scope、Issue、状态机及不变量 |
| 04 | [沙箱与命令策略](./GOAL-04-sandbox-command-policy.md) | 强/弱隔离、只读 Reviewer、命令授权 |
| 05 | [类型化 Evidence Store](./GOAL-05-evidence-store.md) | Evidence 判别联合、Artifact 哈希、预算和索引 |
| 06 | [Verification、视觉与人工证据](./GOAL-06-verification.md) | 隔离验证、受控工具、视觉证据、`attest` |
| 07 | [Execution 与 Candidate](./GOAL-07-execution-candidate.md) | Execution 只能产生 Candidate |
| 08 | [独立 Task Review](./GOAL-08-task-review.md) | Task Review、Issue 门禁、反馈循环 |
| 09 | [影响分析与 Revalidation](./GOAL-09-invalidation.md) | 确定性失效、拓扑重验、当前 HEAD 完成语义 |
| 10 | [独立 Plan Review 与用户决定](./GOAL-10-plan-review.md) | Plan Review、修订循环、`answer` |
| 11 | [Final Review、Context 与 Budget](./GOAL-11-final-review-budget.md) | 唯一完成门槛、索引化上下文、显式预算 |
| 12 | [CLI、进度、报告与运行控制](./GOAL-12-cli-report-runtime.md) | 完整 CLI、报告、归档、heartbeat、中断 |
| 13 | [自动化验收与对抗测试](./GOAL-13-automated-acceptance.md) | 完整测试矩阵、安全与崩溃恢复证据 |
| 14 | [真实模型评估与发布闭包](./GOAL-14-release-evaluation.md) | 真实评估基线、AC 总审计、完成结论 |

Goal 必须严格按编号执行。前一个 Goal 未达到完成定义时，不得开始后一个 Goal。

## 4. 新会话启动模板

在新的 Goal 会话中使用以下模板，并把文件名替换为当前 Goal：

```text
请执行 docs/goals/GOAL-XX-*.md。

开始前完整读取根 AGENTS.md、docs/SPEC.md、docs/goals/README.md、
docs/goals/STATUS.md、docs/goals/TRACEABILITY.md、当前 Goal 文档及其列出的
前置交接产物。

只实施当前 Goal，不提前实现后续 Goal。严格遵循 SPEC，不保留旧状态、
旧数据、旧报告、兼容、迁移、fallback 或 deprecated 逻辑。

完成当前 Goal 的全部代码、测试、需求账本和 STATUS 更新；运行文档要求的
定向测试与 npm test。只有所有完成条件满足时才把当前 Goal 标为 completed。
如遇需要用户决定、安全方案不可行、权限/凭据/成本缺失或范围必须扩大，
停止并把 Goal 标为 blocked，不要自行假设。
```

每个会话只执行一个 Goal。会话结束时不得顺带开始下一 Goal。

## 5. 每个 Goal 的统一执行协议

### 5.1 开始前

1. 确认 `STATUS.md` 中所有前置 Goal 为 `completed`。
2. 检查 Git 工作树，区分用户已有变更与本 Goal 变更。
3. 阅读当前实现的数据流、状态流和模块依赖。
4. 将当前 Goal 涉及的 requirement ID 从需求账本置为 `in_progress`。
5. 制定仅覆盖当前 Goal 的执行计划。

### 5.2 实施中

- 遵循 `interfaces → bootstrap → adapters → application → domain`。
- Domain/Application 不得依赖 `node:*` 或外层模块。
- 新能力先定义内层契约和 Port，再实现 Adapter，最后在 Composition Root 接线。
- 不增加兼容、迁移、fallback、deprecated 或双写逻辑。
- 不通过跨 Goal 提前实现来掩盖当前架构缺口。
- 不保留巨型函数、隐式状态、魔法字符串或重复完成判定。
- 每个外部副作用必须有明确的 operation、失败窗口与恢复语义。
- 每项测试必须证明行为，不得只断言源码字符串或常量存在。

### 5.3 完成前

1. 运行当前 Goal 指定的定向测试。
2. 运行 `npm test`；若 Goal 明确处于需要短暂替换旧契约的原子重构窗口，必须在同一 Goal 内恢复全绿，不得把红灯交给下一 Goal。
3. 检查架构守护和禁用项扫描。
4. 更新需求账本的 owner、实现位置、测试和状态。
5. 更新 `STATUS.md`，记录提交、测试、交接产物和剩余风险。
6. 确认当前 Goal 的明确非目标没有被偷偷引入。

## 6. 状态规则

`STATUS.md` 中 Goal 状态只能为：

- `pending`
- `in_progress`
- `blocked`
- `completed`

只有当前 Goal 全部完成定义满足、门禁全绿且交接产物存在时，才允许标记 `completed`。

以下情况必须标记 `blocked` 并请求用户决定：

- SPEC 存在无法由实现选择消解的矛盾。
- 强安全边界无法通过技术验证。
- 需要新的权限、成本、真实凭据或外部环境。
- 必须扩大当前 Goal 范围才能继续。
- 用户已有变更与目标修改无法安全协调。

## 7. 防止细节丢失

GOAL-00 必须创建 `docs/implementation/requirement-ledger.md`，为 SPEC 中每条规范性要求分配稳定 ID，并至少记录：

```text
requirementId
SPEC 章节或稳定锚点
要求摘要
owner Goal
owner 模块
验证方式
测试或 Evidence
状态
```

后续会话不得只依据 AC-001～AC-015 工作。AC 是最终验收摘要，逐条需求账本才负责防止正文细节遗漏。

每个 Goal 的交接信息必须写入仓库，不得只写在聊天回复中。

## 8. 完成语义

- 单个 Goal 完成，不代表 SPEC 完成。
- GOAL-13 完成，只代表自动化门禁闭合。
- 只有 GOAL-14 的真实模型评估、AC 总审计和 SPEC §23 全部通过后，整个重构才允许宣布完成。

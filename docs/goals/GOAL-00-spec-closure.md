# GOAL-00：规格闭包与实施基线

## 目标

在修改生产代码前，把 SPEC 的全部规范性要求转化为可追踪实施账本，并关闭会影响安全性、状态协议或发布结论的架构决策。

本 Goal 解决“后续会话依赖聊天记忆”和“实现中途才发现规格不可落地”的风险。

## 前置条件

- 无前置 Goal。
- 当前 `npm test` 必须全绿。
- 工作树中的用户变更已经识别并受到保护。

## 必读

- 完整 `docs/SPEC.md`，重点为 §3、§4、§5、§15、§16、§20.3、§21～§23。
- `docs/goals/README.md`。
- `docs/goals/TRACEABILITY.md`。
- 当前 `src/`、`tests/`、`scripts/`、`package.json` 和 TypeScript 配置。

## 范围

### 1. 创建逐条需求账本

新增 `docs/implementation/requirement-ledger.md`。

必须：

- 为 SPEC 中每条“必须、不得、不允许、只能、一律、应当”等规范性语句分配稳定 ID。
- 将表格中的每一项约束、状态转换、错误映射、Evidence 字段和完成条件单独登记。
- 为每条要求指定 owner Goal。
- 记录预计 owner 模块、验证方法和最终 Evidence。
- 区分 `deliverable`、`global_constraint` 和 `user_decision`。
- 登记 AC-001～AC-015 与 §23 完成定义，但不得用 AC 替代正文条款。

建议 ID 格式：

```text
REQ-S05.2-001
REQ-S12.5-004
REQ-AC-010
REQ-DOD-007
```

### 2. 创建目标架构蓝图

新增 `docs/implementation/target-architecture.md`，至少说明：

- Domain 聚合与纯函数边界。
- Application 阶段和 Use Case 边界。
- 全部 Port 及其责任。
- Adapter 与 Windows 平台能力。
- Composition Root 接线方向。
- `state.json`、Plan、Session、Evidence、Artifact、Report、History 的所有权。
- Run 从 planning 到 completed 的状态流。
- Candidate、Task Review、Revalidation 和 Final Review 的数据流。
- operation ID 与外部副作用的协调图。

蓝图不得将业务规则放入 Composition Root、Adapter 或 Prompt。

### 3. 形成高风险架构决策

新增 `docs/implementation/decisions/`，至少形成以下 ADR：

1. Windows 文件系统强隔离如何真正阻止 Reviewer 写工作区和仓库外路径。
2. Reviewer 模型认证、必要网络和最小环境如何同时成立。
3. Verification 网络强隔离、弱隔离与用户逐 Run 批准的实现。
4. 进程树终止和退出确认协议。
5. heartbeat 单实例的原子租约协议，避免并发启动竞态。
6. `state.json` 顶层聚合和 immutable artifact 命名、哈希与索引协议。
7. `activeOperation` 支持的 stage 集合和各 stage 崩溃窗口。
8. 用户决定、弱隔离批准、网络批准和人工证据的输入契约。
9. Run Budget 字段、单位、默认策略和 CLI 覆盖方式。
10. 真实模型评估集、trial 规则、基线文件和发布比较算法。

ADR 必须包含：

- 背景和约束。
- 被考虑的方案。
- 选择及理由。
- 安全边界。
- 失败和恢复行为。
- 对模块和测试的影响。
- 未解决问题。

ADR 不得覆盖 SPEC；确需改变 SPEC 时必须先获得用户决定。

### 4. 高风险可行性验证

对以下内容进行最小、可删除的技术验证：

- Windows 强隔离能否在不引入禁用原语、原生扩展和危险主机 ACL 修改的情况下成立。
- Reviewer 只读工作区能否在真实 Claude CLI 启动条件下成立。
- 隔离进程树超时后能否确认全部退出。
- 单实例租约能否抵抗两个并发启动者。

验证代码只能位于测试或专门的 spike 目录，不得混入 `src/`。验证结论写入 ADR；不可行的 spike 应删除，保留测试结果或复现实验说明。

### 5. 建立实施测试地图

新增 `docs/implementation/test-map.md`，把 §20 和 §23 映射到：

- Domain 单元测试。
- Application 合约测试。
- Adapter/Windows 集成测试。
- Fake Claude E2E。
- 安全和对抗测试。
- 崩溃窗口测试。
- 真实模型评估。

## 明确不在范围

- 不实现新状态模型。
- 不修改 Run Driver 业务流。
- 不创建兼容层或迁移器。
- 不实现 Sandbox、Evidence、Review 或 CLI 新命令。
- 不因文档工作降低现有测试。

## 完成定义

- 需求账本覆盖 SPEC 全部章节、AC 和完成定义，不存在无 owner 条目。
- 所有高风险 ADR 已接受，或已明确请求用户决定并将 Goal 标记为 blocked。
- 强隔离、进程树和单实例方案具有可重复的技术证据。
- 目标架构中不存在巨型协调器、跨层依赖或双重状态事实。
- 测试地图覆盖 §20.1、§20.2、§20.3 和 §23。
- `npm test` 全绿。
- `STATUS.md` 已记录所有交接文档路径。

## 交接给 GOAL-01

GOAL-01 必须读取：

- `docs/implementation/requirement-ledger.md`
- `docs/implementation/target-architecture.md`
- `docs/implementation/decisions/`
- `docs/implementation/test-map.md`

任何未关闭的高风险决策都会阻止 GOAL-01 开始。


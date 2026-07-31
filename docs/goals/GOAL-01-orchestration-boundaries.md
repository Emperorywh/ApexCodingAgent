# GOAL-01：编排阶段边界重构

## 目标

先消除当前 Run Driver 和巨型 Use Case 的职责混合，建立能够承载新流程的显式阶段边界，但不在本 Goal 内堆入后续 Evidence、Review 或 Invalidation 业务。

对应 SPEC §4.1～§4.3、§15.5、§22 第 1 步和 AC-014。

## 前置条件

- GOAL-00 已完成。
- 全部高风险 ADR 已关闭。
- 需求账本和目标架构蓝图存在。

## 必读

- SPEC §1～§4、§8、§15.5、§19、§22。
- GOAL-00 的目标架构和 ADR。
- 当前：
  - `src/application/run-driver.ts`
  - `src/application/usecases/execute-next-task.ts`
  - `src/application/usecases/run-final-review.ts`
  - `src/application/usecases/claude-session.ts`
  - `src/application/usecase-deps.ts`
  - `src/bootstrap/composition-root.ts`

## 目标边界

Application 层至少应清晰区分：

- Run 协调循环。
- 阶段选择与阶段结果。
- Claude Session 调用服务。
- 状态转换提交。
- Git 阶段事实。
- Prompt 构建。
- 进度事件。
- 错误到可恢复状态的转换。

Run Driver 只负责：

1. 读取已提交状态。
2. 由纯阶段选择器决定下一阶段。
3. 调用一个阶段 Use Case。
4. 根据已提交结果继续或停止。

Run Driver 不得直接构造大型状态对象、解析模型结果、执行 Git 细节、渲染报告或包含阶段专属恢复规则。

## 实施要求

### 1. 拆分阶段协调

- 为 planning、execution、task review、revalidation、final review、report/archive 预留独立阶段边界。
- 未在当前 Goal 实现的阶段只能作为类型层面的可识别结果，不得用运行时假成功占位。
- 阶段结果使用判别联合，不使用布尔组合或字符串猜测。
- 阶段选择是可单测的纯逻辑。

### 2. 拆分 Session 能力

- Claude 进程调用、stream-json 解析、Session Record 构造和应用层阶段语义分离。
- Prompt 始终通过 stdin。
- argv 只承载控制参数。
- 保留并强化超过 32,767 字符 Prompt 的集成边界。
- Session 失败只返回稳定结构化事实，不让原始工具退出码进入 CLI。

### 3. 收敛依赖

- 避免把所有 Port 集合继续扩张为新的 Service Locator。
- 每个阶段工厂只接收实际需要的依赖。
- Composition Root 只创建实现并接线。
- 公共逻辑提取为有明确名称的应用服务或领域函数。

### 4. 删除重复逻辑

重点检查并消除：

- 多处 Run failed 收尾。
- 多处 Session 开始/结束。
- 多处 SPEC/Git 前后校验。
- 多处状态 revision 增加。
- 多处错误转换。
- Execution 与 Final Review 中复制的 checkpoint/Session 流程。

不得为了复用而创建承载所有阶段分支的巨型通用函数。

## 明确不在范围

- 不引入 `state.json` 新聚合；由 GOAL-02 完成。
- 不实现新 Plan/Issue/Evidence Schema。
- 不实现 Sandbox 或 Command Policy。
- 不实现独立 Review。
- 不改变最终 CLI 命令集。
- 不保留旧模块的兼容 facade 供最终系统长期使用。

## 测试

必须覆盖：

- 阶段选择的所有 Run 状态。
- 每个阶段结果只触发合法下一阶段。
- 意外异常进入统一失败边界。
- Prompt 通过 stdin，包括超长 Prompt。
- Composition Root 没有业务判断。
- Domain/Application 架构守护继续通过。

## 完成定义

- Run Driver 成为小型串行协调器，每个分支只有阶段调用和结果路由。
- 原巨型 Use Case 已按单一职责拆分，没有仅换文件名的巨型服务。
- 未出现循环依赖、跨层依赖或新的全局隐式状态。
- 所有现有行为测试与 `npm test` 全绿。
- 需求账本中本 Goal 条目具有实现和测试链接。
- `STATUS.md` 已记录新阶段边界和 GOAL-02 必须使用的接口。

## 交接给 GOAL-02

交接必须明确：

- Run Driver 调用的阶段接口。
- 状态读取和提交的唯一入口。
- Session 与外部副作用的应用层边界。
- GOAL-02 替换旧状态存储时需要删除的旧契约。


# GOAL-09：影响分析与 Revalidation

## 目标

实现确定性 Impact Analyzer，使后续 Candidate 对历史 Review 的 path、scope、dependency 和 Evidence 影响立即失效，并在新 HEAD 上按依赖顺序重验。

对应 SPEC §6.5、§8、§12.1、§12.6、§13、AC-003、AC-008 和 §22 第 7 步。

## 前置条件

- GOAL-08 已完成。
- 有效 ReviewFootprint、Candidate changedPaths、Scope Graph 和 Task Review 可用。

## 必读

- SPEC §6.5、§8、§12、§13、§14.1。
- Scope/Path 规范。
- Candidate、ReviewFootprint 和 dependency facts。
- Task 依赖图与阶段选择器。

## 范围

### 1. Impact Analyzer 输入

只使用确定性输入：

- Git normalized changedPaths。
- Plan scope graph。
- 当前 Task mayAffectScopes。
- ReviewFootprint paths/scopes/dependencyFacts。
- Evidence 依赖文件哈希。
- Reviewer 结构化影响声明。

自由文本 changedAreas/changedScopes 不得作为确定性输入。

### 2. 六类失效条件

逐项实现 SPEC §13.2：

1. changed path 与 Footprint path 相交。
2. mayAffectScopes 沿 scope graph 到达 Footprint scope。
3. dependency fact 变化。
4. Evidence 文件哈希变化。
5. Reviewer 明确声明影响。
6. 未登记且无法安全归类的全局路径变化。

全局路径分类必须是版本化、可测试的确定性规则，不得使用含义模糊的名称猜测。

SPEC 哈希变化直接回 planning，不进入普通失效。

### 3. 失效提交

每次失效必须原子记录：

- 来源 Task。
- Candidate。
- 被影响 Task/criterion/Review。
- paths、scopes、dependency facts。
- 时间。
- 新 reviewedHead。

历史 completed Task 转为 review_pending；历史 Review 保留但标记无效，不删除。

### 4. Revalidation 调度

新 Candidate 后：

1. 先计算所有受影响 completed Task。
2. 按 Task 依赖拓扑顺序创建 revalidation subject。
3. 以新 Candidate HEAD 为 reviewedHead。
4. 重新采集当前 Head Evidence。
5. 旧 Task 全部重新 accepted 后才 Review 新 Task。

任一历史 criterion 不成立时，新 Task不得完成，必须进入结构化修复或 replan。

### 5. Revalidation Review

复用 GOAL-08 的 Task Review 引擎，但必须：

- reviewKind 为 revalidation。
- implementationCheckpoint 保持历史 Task 的 Candidate/Accepted OID。
- reviewedHead 使用当前新 HEAD。
- trigger 完整记录来源。
- Evidence 全部绑定新 Head。
- 产生新的有效 ReviewFootprint。

### 6. Issue resolution

Issue resolution 引用的 path、scope、dependency 或 Evidence 失效时，resolution 必须重新检查；不能因为 Issue 曾 resolved 就跳过。

共享文件频繁失效只记录架构指标，不自动生成 Finding。是否形成 Finding 由 Reviewer 基于模块职责判断。

## 明确不在范围

- 不实现 Plan Review。
- 不实现 Final Review。
- 不用固定失效次数判定架构问题。
- 不用字符串前缀猜 scope。
- 不删除历史 Review 或 Evidence。

## 测试

必须同时覆盖应失效与不应失效：

- path 相交/不相交。
- Windows 大小写和 separator。
- rename 旧、新路径。
- scope 单边、多边传播和无路径。
- dependency file/tool/config 变化和未变化。
- Evidence hash 变化。
- Reviewer 显式影响。
- 未登记全局配置与普通局部文件。
- SPEC hash 直接 planning。
- 拓扑 revalidation 顺序。
- 旧 Review 失败阻止新 Task。
- 新 Head Evidence 与旧 Head Evidence。
- Issue resolution 重新检查。

## 完成定义

- 任一 Candidate 后不存在“已过期但仍 completed”的 Review。
- Revalidation 使用新 Head 且保留 implementationCheckpoint。
- 新 Task Review 严格等待历史受影响 Task。
- 失效和重验历史完整可审计。
- 失效算法是纯、确定性且双向测试充分。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-10

交接必须列明：

- Plan/SPEC 变化触发 planning 的入口。
- 现有 Task/criterion/Review 在 Plan Revision 中的身份规则。
- 当前有效 Review 和失效历史索引。


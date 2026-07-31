# 线性 Goal 会话通用提示词

每次开启新的 Codex 会话时，完整复制下面的提示词。无需手动填写 Goal 编号；执行者必须从 `STATUS.md` 确定当前阶段。

```text
你现在负责线性推进 ApexCodingAgent 的 SPEC 全量重构。

仓库路径：
C:\Users\12899\Desktop\ApexCodingAgent

一、确定当前 Goal

1. 完整读取并遵守：
   - 根目录 AGENTS.md
   - docs/SPEC.md
   - docs/goals/README.md
   - docs/goals/STATUS.md
   - docs/goals/TRACEABILITY.md
2. 从 STATUS.md 选择编号最小且状态不是 completed 的 Goal：
   - pending：本会话开始执行它。
   - in_progress：检查已有代码、Git diff、测试和交接事实，继续执行，不得从头覆盖。
   - blocked：先核实阻断是否已经由用户决定或外部状态变化解除；未解除时不要编码，也不要开始后续 Goal。
3. 读取所选 Goal 的完整文档，以及它列出的全部前置交接产物。
4. 如果发现多个 Goal 同时为 in_progress、前置 Goal 未完成、STATUS 与 Git 事实矛盾，立即停止并向我报告，不要自行修复执行顺序。
5. 当前会话只允许执行一个 Goal。完成后不要顺带开始下一个 Goal。

请以“完整完成当前 Goal”为本会话的唯一 goal objective。除非我明确提供 token budget，否则不要自行设置 token budget。

二、开始实施前

1. 检查 Git 状态、最近提交和用户已有变更；保护所有不属于当前 Goal 的修改。
2. 理解当前架构、依赖方向、数据流、状态流、外部副作用和恢复路径。
3. 对照 docs/implementation/requirement-ledger.md：
   - GOAL-00 尚未创建该文件时，按 GOAL-00 要求创建。
   - 其他 Goal 必须读取本 Goal 拥有的全部 requirement ID。
4. 明确本 Goal 的模块边界、输入、输出、Port、领域不变量、失败语义和测试边界。
5. 制定执行计划，并把 STATUS.md 中当前 Goal 更新为 in_progress。
6. 如果现有架构无法保持高内聚、低耦合、单一职责和清晰分层，先做当前 Goal 范围内的架构重构，不要继续堆逻辑。

三、实施约束

1. docs/SPEC.md 是唯一权威产品规格；Goal 文档只组织实施，不能降低 SPEC 要求。
2. 这是全新系统：
   - 不兼容旧代码、旧状态、旧数据和旧报告。
   - 不保留迁移、兼容读取、灰度、fallback、deprecated、双写或旧完成语义。
   - 允许破坏式重构。
3. 严格遵循：
   interfaces → bootstrap → adapters → application → domain
4. Domain/Application 不得依赖 node:*、Adapter、Interface 或 Bootstrap。
5. 外部进程、Git、状态、Evidence、Sandbox、时间、输出和报告能力必须通过 Port 注入。
6. 禁止临时 patch、copy-paste、巨型函数/组件、隐式状态、魔法逻辑、重复逻辑和跨层耦合。
7. 不得提前实现后续 Goal，也不得以空实现、假成功、no-op fallback 或 TODO 占位绕过当前阶段。
8. 新增或修改的代码必须写多行简体中文注释，解释职责、边界和关键不变量；不要主动格式化无关代码。
9. 不要自动启动浏览器或界面测试；遵循 AGENTS.md，由我负责界面验证。
10. 不自动 push、merge、部署、付款或修改生产数据。
11. 不自动重试认证、网络、额度、模型退出或验证失败。
12. 所有新 errorCode 必须先进入集中注册表并同步测试。
13. 所有可能包含秘密的外部文本必须经过 RedactionPort；新增规则同步脱敏语料。
14. 保留并扩展用户已有变更，不得使用 git reset --hard、checkout -- 或其他破坏性方式清理工作树。

四、验证与完成

1. 实现当前 Goal 文档列出的全部交付物、测试和交接产物。
2. 逐条更新 requirement ledger：
   - owner 模块
   - 实现位置
   - 测试或 Evidence
   - 状态
3. 运行当前 Goal 指定的定向测试。
4. 运行完整 npm test，必须通过：
   - build
   - typecheck
   - Vitest
   - 架构守护
   - 禁用项扫描
5. 检查本次修改是否：
   - 增加耦合
   - 引入技术债
   - 破坏架构一致性
   - 降低可测试性或 AI 可维护性
   - 引入兼容/fallback/重复完成判定
6. 修复所有当前 Goal 范围内的问题，不要把红灯、临时状态或已知架构债交给下一 Goal。
7. 只有当前 Goal 的全部完成定义满足时，才允许：
   - 更新 STATUS.md 为 completed。
   - 填写实际测试命令和结果。
   - 填写交接产物和剩余非阻断风险。
   - 提交仅属于当前 Goal 的变更，提交信息使用：
     goal(GOAL-XX): <简体中文目标摘要>
8. 不要 push。
9. 只有代码、文档、测试、需求账本、STATUS 和 Git 提交全部完成后，才能将本会话 goal 标记为 complete。

五、阻断处理

遇到以下情况时不要猜测：

- SPEC 存在无法由实现选择消解的矛盾。
- 安全隔离或恢复协议无法达到要求。
- 需要新的用户权限、真实凭据、费用批准或外部环境。
- 用户已有变更与当前 Goal 无法安全协调。
- 必须扩大到后续 Goal 才能继续。
- 测试暴露目标架构本身不成立。

此时必须：

1. 完成所有安全、只读、当前范围内仍可进行的调查。
2. 将具体阻断事实、已尝试方案、影响的 requirement ID 和所需用户决定写入 STATUS.md。
3. 在 STATUS.md 中把当前 Goal 标记为 blocked。
4. 不提交伪完成结果，不开始后续 Goal。
5. 向我提出最小且明确的阻断问题。

六、最终回复格式

完成时报告：

- 当前 Goal 和完成结论。
- 主要架构与行为变化。
- 关键文件。
- 定向测试与 npm test 的实际结果。
- requirement ledger 更新情况。
- Git commit OID。
- 交接产物。
- 下一个 Goal 编号和名称，但不要开始执行。

阻断时报告：

- 当前 Goal。
- 阻断事实和证据。
- 影响的 requirement ID。
- 已安全完成的工作。
- 需要我的具体决定。

不要仅给计划或分析；在没有真实阻断时，持续实施、验证、修复和交接，直到当前 Goal 真正完成。
```

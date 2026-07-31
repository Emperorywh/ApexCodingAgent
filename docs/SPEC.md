# SPEC：ApexCodingAgent 独立复核与质量闭环

> 状态：待实施
> 适用项目：`apex-coding-agent`
> 目标平台：Windows，Node.js 22.x / 24.x
> 实施性质：全量重构，不兼容现有运行状态和报告
> 主要问题来源：`china-3d` 长任务运行复盘

---

## 1. 文档目的

本文定义 ApexCodingAgent 的目标产品和工程规格（待实施的全量重构版本）。

系统必须把长任务编码流程组织为：

```text
计划草案
  → 独立计划复核
  → Task 实现
  → Candidate Checkpoint
  → 独立 Task Review
  → Task 完成
  → 受影响验收重新复核
  → 独立 Final Review
  → Run 完成
```

“完成”必须是由当前仓库事实、结构化证据和独立复核共同支持的领域结论。执行 Agent 的自然语言陈述、测试数量、代码存在性或历史通过记录均不能独立决定完成。

本文是实现的唯一权威需求。若本文与现有代码冲突，以本文为准；实现不得保留兼容分支、迁移、fallback、deprecated 字段或旧完成语义。

---

## 2. 问题与目标

### 2.1 已观察到的失败模式

`china-3d` Run 暴露出以下系统性问题：

1. 所有 Task 被执行 Agent 标记为完成，但 Final Review 因 Windows 命令行过长没有启动，Run 实际失败。
2. Task 结果同时记录“字体不可读”和“文字可读验收满足”。
3. 对象数量、四元数、亮色像素等间接事实被错误解释为视觉质量。
4. 后续 Task 修改共享文件、相机和渲染参数后，早期验收不会失效。
5. 执行 Agent 同时实现、解释证据并裁决完成，存在确认偏差。
6. 临时验证脚本和截图被删除，只留下无法复现的自然语言结论。
7. 参考项目的历史结论被当作当前产品证据。
8. Final Review 未通过时仍可能显示 Task `100%`。
9. Session、验证或报告阶段失败后缺少准确、幂等的恢复点。

### 2.2 核心目标

- Execution 只能产出 Candidate，不能完成 Task。
- 每个 Task 必须由独立上下文中的 Reviewer 接受。
- 每个阻断验收结论必须引用与当前复核 HEAD 绑定的 Evidence。
- 与验收条件冲突的 Issue 必须阻止完成。
- 后续变更必须使受影响的历史 Review 失效并在新 HEAD 上重验。
- 视觉、交互、性能和跨模块风险必须通过早期纵向里程碑暴露。
- Final Review 是唯一的 Run 完成门槛。
- 中断和基础设施错误必须从准确阶段幂等恢复。
- CLI 必须区分 Candidate、Task Review、重验和 Final Review 进度。
- 所有模型、命令和仓库内容均在明确的信任与权限边界内运行。

### 2.3 非目标

- 不并行执行 Task。
- 不自动推送远程、部署、付款或修改生产数据。
- 不自动重试认证、网络、额度、模型退出或验证失败。
- 不允许 Reviewer 修改业务代码。
- 不把测试数量、代码行数或像素数量当作产品质量。
- 不引入 Mutex、Named Pipe、Job Object、自实现的 PID 追踪/复活协议、Journal 或原生扩展。本项禁止的是内核对象与自实现的进程追踪协议；使用 `spawn` 进程句柄和系统工具（如 `taskkill /T`）终止进程树不属于此类（见 §5.2）。

---

## 3. 规范术语与权威层级

### 3.1 规范词

- **必须**：实现不可偏离。
- **不得**：明确禁止。
- **应当**：无明确阻断原因时实施。
- **可以**：可选实现，但不得破坏强制要求。

### 3.2 领域术语

| 术语 | 定义 |
|---|---|
| Plan Draft | 尚未通过独立复核的计划草案 |
| Plan Review | 独立 Session 对需求覆盖、Task 边界和验收设计的复核 |
| Candidate Checkpoint | Execution 产生的候选 Git 提交，不代表完成 |
| Accepted Checkpoint | Candidate 被 Task Review 接受后的领域身份，可与 Candidate 使用同一 OID |
| Review Subject | 一次 Review 的实现提交、实际复核 HEAD 和触发原因 |
| Evidence | 系统采集、可定位、可校验且与复核 HEAD 绑定的事实 |
| Issue | 已观察到的问题或尚未消除的风险 |
| Review Footprint | 一次有效 Review 覆盖的 criterion、路径、scope、依赖事实和 HEAD |
| Invalidation | 后续变更使既有 Review 失效 |
| Final Review | 对整体架构、规格闭包和默认用户路径的最终独立复核 |

### 3.3 权威层级

发生冲突时按以下顺序裁决：

1. 用户显式决定和目标仓库权威 SPEC。
2. Git、文件哈希、命令退出码和系统采集的 Evidence。
3. 已接受的 Plan、Review Footprint 和结构化状态。
4. Reviewer 的结构化判断。
5. Execution summary、模型自述和历史参考。

低层级信息不得覆盖高层级事实。

---

## 4. 总体架构

### 4.1 依赖方向

```text
interfaces/cli
    ↓
bootstrap
    ↓
adapters
    ↓
application
    ↓
domain
```

- Domain 和 Application 不得依赖 `node:*`。
- Domain/Application 不得引用 Adapter、Interface 或 Bootstrap。
- 外部进程、Git、状态、Evidence、沙箱、时间和输出全部通过 Port 注入。
- Composition Root 只负责接线，不包含业务规则。

### 4.2 模块边界

```text
src/
├─ domain/
│  ├─ run-state.ts
│  ├─ task-state.ts
│  ├─ plan.ts
│  ├─ review.ts
│  ├─ evidence.ts
│  ├─ issue.ts
│  ├─ impact.ts
│  ├─ recovery.ts
│  ├─ invariants.ts
│  └─ schemas/
├─ application/
│  ├─ ports/
│  │  ├─ verification.ts
│  │  ├─ visual-evidence.ts
│  │  ├─ evidence-store.ts
│  │  ├─ sandbox.ts
│  │  ├─ command-policy.ts
│  │  └─ ...
│  ├─ prompts/
│  └─ usecases/
│     ├─ create-plan.ts
│     ├─ review-plan.ts
│     ├─ execute-task.ts
│     ├─ collect-evidence.ts
│     ├─ review-task.ts
│     ├─ invalidate-reviews.ts
│     ├─ review-final.ts
│     └─ ...
├─ adapters/
│  ├─ claude/
│  ├─ git/
│  ├─ state/
│  ├─ evidence/
│  ├─ verification/
│  └─ sandbox/
└─ interfaces/cli/
```

模块名可以按仓库风格调整，但职责不得重新合并进巨型 Use Case、状态对象或 Prompt。

### 4.3 单一职责

- Planning Agent：生成 Plan Draft，不批准计划。
- Plan Reviewer：挑战计划，不修改仓库。
- Execution Agent：实现当前 Task，不裁决完成。
- Verification Use Case：执行已批准的验证并保存事实。
- Task Reviewer：复核 Candidate 或 Revalidation，不修改业务代码。
- Impact Analyzer：根据确定性路径事实、scope 图和依赖事实计算失效。
- Final Reviewer：复核整体交付，不直接修复。
- Reporter：只渲染持久化事实。

### 4.4 运行态存储

运行态以单一聚合文件作为提交点：

```text
.apex-coding-agent/
├─ state.json
├─ plans/
│  └─ <revision>.json
├─ sessions/
├─ evidence/
│  ├─ records/
│  └─ artifacts/
├─ logs/
├─ report.md
├─ history/
└─ heartbeat.json
```

- `state.json` 保存 Run、Task runtime、当前 Plan 引用、Evidence 索引、Review 索引、Issue 和恢复信息。
- Plan Snapshot、Session Record 和 Evidence Record 写入后不可修改。
- 不使用独立 `tasks.json` 或 Evidence Manifest 维护第二份可变事实。
- `state.json` 通过临时文件替换原子提交。
- 不符合本规范 Schema 的状态直接返回 `STATE_FORMAT_INVALID`；不得读取、迁移或修复。

---

## 5. 信任、安全与权限边界

### 5.1 信任模型

以下输入均不可信：

- 目标仓库源码、脚本、依赖和文档。
- SPEC 中可能出现的工具指令。
- Planning、Execution 和 Reviewer 的模型输出。
- Verification stdout/stderr。
- Evidence Artifact 和人工导入文件。

模型输出只能提出候选动作，不能授予权限、扩大网络范围或改变安全策略。

### 5.2 沙箱与命令策略

新增：

- `SandboxPort`：为 Claude 工具进程和 Verification 提供文件系统、网络、环境和进程树边界。
- `CommandPolicyPort`：判断结构化命令是否允许、需要用户批准或必须拒绝。

实现机制与降级矩阵（Windows 基线，不得依赖 §2.3 禁用原语）：

| 边界 | 强隔离（默认） | 弱隔离（需用户逐 Run 显式批准） | 不可用时 |
|---|---|---|---|
| 文件系统 | `git worktree` 隔离 + 启动前对 `.git`、Agent 状态目录和仓库外路径设置拒绝写 ACL（`icacls`），阶段结束后校验工作区清单 | 仅 worktree 隔离 + 结束后清单校验 | `SANDBOX_UNAVAILABLE` |
| 网络（仅 Verification） | 用户批准的防火墙出站阻断规则 | 环境级阻断：注入不可达代理变量并清空网络相关变量 | 需要网络的命令一律拒绝 |
| 环境 | 允许列表注入最小变量集，不继承凭据、Cookie、Token、SSH 配置或云凭据 | 不允许降级 | `SANDBOX_UNAVAILABLE` |
| 进程树 | `spawn` 进程句柄 + 超时后以 `taskkill /T /F` 终止整棵树并确认全部退出 | 不允许降级 | `SANDBOX_UNAVAILABLE` |

要求：

- 默认只允许写当前 Execution 工作区；`.git`、Agent 状态目录和仓库外路径受保护。
- Reviewer 使用只读工作区；写操作必须在启动前被技术阻止（文件系统强隔离），不能只在结束后检测。
- Reviewer 只读边界和 Verification 环境允许列表不允许降级为弱隔离。
- Verification 在以 `reviewedHead` 创建的隔离工作区中运行，不得直接修改 Run 工作树。
- Verification 默认禁止外网；需要网络的命令必须在 Plan 中声明目标并获得策略或用户批准。
- Verification 环境使用允许列表，不得原样继承凭据、Cookie、Token、SSH 配置或云凭据。
- 限制必须传播到全部子进程；超时后必须确认进程树已经终止。
- 沙箱不可用时不得退化为直接执行，返回 `SANDBOX_UNAVAILABLE`。
- 每次弱隔离降级必须记录批准事实，写入 Session Record 与最终报告。

权限分工（三方边界）：

- Execution Session：Claude 的工具调用由 Claude Code 权限系统裁决（默认自动权限模式）；ApexCodingAgent 不逐命令审批，但以沙箱文件系统边界兜底。Execution 的 Claude 进程默认允许访问网络（模型 API 必需），网络边界不适用于 Execution。
- Reviewer 与 Verification：不依赖 Claude 权限系统；只读与命令授权必须由上表技术边界保证。
- 远程推送、部署、付款、生产数据操作：任何阶段一律拒绝或请求用户批准，不被任何权限模式豁免。

`--full-access`：

- 只能由用户显式启用并显示风险提示。
- 只影响 Execution Session（Claude Code `bypassPermissions`）。
- 不得解除 Reviewer 只读边界、Verification 命令策略或远程操作禁令。

### 5.3 命令授权

`shell: false` 和参数数组是必要条件，但不构成授权。

允许的 Verification 命令必须：

- 来自已接受 Plan 的命令目录或系统受控工具目录。
- 在执行前通过 `CommandPolicyPort`。
- 使用解析后的真实可执行文件路径进行审计。
- cwd 位于隔离工作区内。
- 有明确 timeout、网络策略和输出预算。

"系统受控工具目录"是随版本发布的内置工具登记表：`toolId → 可执行文件解析规则、固定参数约束、网络需求`。模型与 Reviewer 只能引用 `toolId`，不得提供任意可执行文件路径；解析后的真实路径按本节要求审计。

未知可执行文件、动态 Shell、远程推送、部署、付款、生产数据操作必须拒绝或请求用户批准。

### 5.4 隐私与审计

- Claude、Verification、Evidence summary 和报告中的外部文本必须经过 RedactionPort。
- 无法安全脱敏的 Artifact 不保存，只记录拒绝原因。
- Session Record 保存模型标识、CLI 版本、Prompt 哈希、权限策略哈希和开始/结束时间。
- 命令 Evidence 保存真实可执行文件、argv、cwd、退出码、时间和策略事实。
- 审计记录用于追踪和完整性检查，不宣称能抵抗拥有本机写权限的恶意用户。

---

## 6. Plan

### 6.1 PlannedTask

```json
{
  "id": "TASK-001",
  "title": "非空标题",
  "objective": "单一可观察目标",
  "dependsOn": [],
  "ownedScopes": ["labels.readability"],
  "mayAffectScopes": ["visual.default-view"],
  "criterionIds": ["AC-TASK-001-01"],
  "verificationCommandIds": ["VC-TASK-001-01"],
  "likelyPaths": ["src/labels.ts"],
  "riskLevel": "high",
  "reviewProfile": "deep",
  "milestoneForScopes": ["visual.default-view"],
  "contextRefs": ["SPEC#labels", "docs/ARCHITECTURE.md#rendering"]
}
```

规则：

- Task 按可独立实现和验证的能力结果拆分，不按文件或技术层机械拆分。
- 每个 Task 只有一个主要 objective。
- `dependsOn` 只表达硬验收依赖。
- `ownedScopes` 必须内聚。
- `mayAffectScopes` 必须保守覆盖跨模块影响。
- 无 criterion 的 Task 无效。
- `riskLevel` 枚举：`low | medium | high`；`reviewProfile` 枚举：`standard | deep`。
- `riskLevel = high` 时 `reviewProfile` 必须为 `deep`。
- `contextRefs` 指向必要上下文；Execution 不默认内联完整 SPEC。

### 6.2 AcceptanceCriterion

```json
{
  "id": "AC-TASK-001-01",
  "sourceRefs": ["SPEC#REQ-LABEL-READABILITY"],
  "statement": "默认 1920×1080 视口下指定文字可读取",
  "kind": "visual",
  "blocking": true,
  "scopes": ["visual.default-view", "labels.readability"],
  "evidencePolicy": {
    "allOf": [
      { "kind": "image" },
      {
        "anyOf": [
          { "kind": "ocr" },
          { "kind": "measurement" },
          { "kind": "manual_attestation" }
        ]
      }
    ]
  },
  "verificationNotes": "描述验证条件，不描述实现步骤"
}
```

规则：

- ID 在完整 Run 内稳定且唯一。
- `statement` 描述用户或系统可观察结果。
- criterion 默认为阻断项；纯信息检查才允许 `blocking: false`。
- `scopes` 不能为空。
- Evidence Policy 使用 `allOf`、`anyOf` 和 `kind` 明确表达，不使用含义不明的字符串数组。
- 非阻断 criterion 可以不满足，但必须在 Review 和报告中明确显示，不得伪装成通过。

允许的 `kind`：

- `automated`
- `repository_fact`
- `visual`
- `manual`
- `performance`

criterion `kind` 与 Evidence `kind`（§10.1）的允许映射：

| criterion kind | 可接受的 Evidence kind |
|---|---|
| automated | command |
| repository_fact | repository_fact、document |
| visual | image，另加 ocr、measurement、manual_attestation 之一 |
| manual | manual_attestation |
| performance | measurement、command |

Evidence Policy 出现映射表之外的组合视为 Schema 无效。

### 6.3 VerificationCommand

Verification 命令统一存放在 Plan 的 command catalog：

```json
{
  "id": "VC-TASK-001-01",
  "argv": ["npm", "test"],
  "workingDirectory": ".",
  "criterionIds": ["AC-TASK-001-01"],
  "providedByTaskId": null,
  "timeoutSeconds": 900,
  "network": "deny",
  "expectedArtifacts": []
}
```

- `providedByTaskId = null` 表示命令在 Plan Review 时已经存在。
- Task 将新增该脚本时，`providedByTaskId` 必须等于对应 Task ID，并在其 Candidate 上验证存在性。
- `workingDirectory` 必须是 Git 相对路径。
- 命令不得要求 Shell 字符串拼接。
- 相同命令不得重复登记制造测试数量。
- Plan 必须单独保存 `finalVerificationCommandIds`，供 Final Review 使用。
- Plan 可以声明 `workspaceProvision`：隔离工作区的依赖准备策略（从 Run 工作区同步的目录列表，或需网络批准的安装命令 ID），见 §10.4。

### 6.4 Requirement Trace

Plan Snapshot 必须区分：

- `deliverable`：需要 Task 交付的产品或工程结果。
- `global_constraint`：由领域不变量、架构守护、安全策略或 Final Review 持续保证的约束。
- `user_decision`：必须由用户确认，模型不得自行假设的决定。

```json
{
  "requirementRef": "SPEC#REQ-LABEL-READABILITY",
  "type": "deliverable",
  "criterionIds": ["AC-TASK-001-01"],
  "ownerTaskId": "TASK-001",
  "policyIds": []
}
```

要求：

- 每个规范性要求必须出现在追踪矩阵中。
- 每个 deliverable criterion 只有一个 owner Task。
- global constraint 可以由 policy、架构守护或 Final Review 负责，不强行分配给业务 Task。
- user decision 未解决时 Plan 不得通过。
- source ref 必须是稳定 Requirement ID 或文档锚点，不依赖易漂移的行号。

### 6.5 Scope Graph 与里程碑

Plan 必须定义 scope 之间明确的影响边，Impact Analyzer 不得猜测字符串前缀关系。

```json
{
  "scopes": [
    { "id": "labels.readability", "paths": ["src/labels.ts"] },
    { "id": "visual.default-view", "paths": ["src/render/default-view.ts"] }
  ],
  "edges": [
    { "from": "labels.readability", "to": "visual.default-view", "reason": "标签渲染进默认视图" }
  ]
}
```

- 影响边方向为"变更方 → 受影响方"，失效沿边正向传播。
- scope 可以声明代表路径集合；路径使用 §12.6 的统一规范。
- 未登记在 scope graph 中的路径变更按 §13.2 条件 6 保守处理。

视觉、交互、性能或跨模块组合项目必须安排纵向里程碑。里程碑必须在依赖其可行性的扩展工作之前完成，并至少组合：

- 接近最终的默认运行条件。
- 真实关键资产或真实数据。
- 一条核心用户路径。
- 能判断产品目标本身的 Evidence。

不使用固定 Task 百分比作为里程碑正确性的替代。

### 6.6 Plan Revision

- Task 和 criterion 语义未变化时必须保留 ID。
- criterion statement、Evidence Policy 或 owner 发生实质变化时必须创建新 ID，并记录被替代 ID。
- Task 被移除时，相关 requirement 必须由新 Task 接管或经用户决定移除。
- SPEC 哈希变化必须回到 Planning；旧 Review 只保留为历史，不得继续视为有效。
- Plan 中不得包含以“最终验收通过”为自身结果的普通 Task。

---

## 7. 独立 Plan Review

### 7.1 独立性

- 使用新的 Session ID。
- 不续接 Planning transcript。
- 使用只读工作区。
- 先读取 SPEC、仓库事实和系统约束，再读取 Planning assumptions。
- 可以使用同一模型，但必须记录模型标识；“独立”表示上下文和职责隔离，不表示统计独立。

### 7.2 Review 内容

Plan Reviewer 必须检查：

1. requirement trace 是否完整。
2. 是否存在单位、尺度、容量、性能或状态矛盾。
3. Task 是否按能力和可验证结果拆分。
4. 依赖是否表达真实验收依赖。
5. 是否存在无人负责的跨 Task 组合结果。
6. 高风险项目是否有早期纵向里程碑。
7. 参考实现是否被错误当作当前证据。
8. Evidence Policy 是否真正支持 statement。
9. Verification 命令是否存在、由 Task 提供或来自受控目录。
10. scope graph 和 `mayAffectScopes` 是否覆盖跨模块影响。
11. 是否存在过大 Task 或无用户价值的微型 Task。
12. assumptions 是否隐藏了用户决定。
13. 每个 Task 是否内聚、可独立验证且 review profile 合理。
14. final verification 是否覆盖整体架构和默认用户路径。

涉及尺寸、FOV、像素、帧率、内存、容量、金额、速率、采样或误差时，必须执行可复算的数量分析，不能只让模型口头确认公式。

### 7.3 PlanReviewResult

```json
{
  "decision": "accepted",
  "summary": "非空摘要",
  "findings": [],
  "taskAssessments": [],
  "requirementCoverage": [],
  "issues": [],
  "repairInstructions": null,
  "userQuestions": []
}
```

`decision`：

- `accepted`
- `changes_required`
- `user_input_required`
- `failed`

`user_input_required` 必须产生结构化问题和选项，Run 以可恢复失败结束。用户提供决定后执行 `resume`，不得由 Planning Agent 自行猜测。

Plan 修订次数受 Run Budget 约束，不使用隐藏的固定轮数。预算耗尽时返回 `PLAN_REVIEW_BUDGET_EXCEEDED`。

---

## 8. Task 与 Run 状态

### 8.1 TaskStatus

```text
pending
executing
review_pending
reviewing
completed
failed
skipped
```

| 状态 | 含义 |
|---|---|
| pending | 等待实现或根据 Review 反馈修复 |
| executing | Execution Session 正在运行 |
| review_pending | 已有 Candidate，或历史 Review 已失效 |
| reviewing | Task Review Session 正在运行 |
| completed | 当前 HEAD 上全部阻断 criterion 已被独立接受 |
| failed | Task 预算耗尽或暂时不可继续，仅 resume 可恢复 |
| skipped | 当前 Plan 明确移除，且 requirement 已合法处理 |

合法转换：

```text
pending → executing
pending → skipped

executing → review_pending
executing → pending
executing → failed

review_pending → reviewing

reviewing → completed
reviewing → pending
reviewing → review_pending
reviewing → failed

completed → review_pending

failed → pending
```

- `executing → review_pending` 只表示 Candidate 已保存。
- `reviewing → completed` 只能由有效 `TaskReviewResult.decision = accepted` 触发。
- `completed → review_pending` 只能由 Impact Analyzer 触发。
- `failed → pending` 只能由 resume Use Case 触发（如用户调整预算或提供决定后按 `reexecute_task` 继续），必须在 ErrorRecord 与状态中记录触发依据；不存在其他复活路径。
- 依赖 Task 只有处于有效 `completed` 时才满足 `dependsOn`。
- `completed` 是当前 HEAD 上的可撤销结论，Review 历史不可删除。

### 8.2 RunStatus

```text
planning
running
final_review
completed
failed
abandoned
```

- `planning`：创建或修订 Plan 并完成 Plan Review。
- `running`：串行执行 Task、Evidence、Review 和 Revalidation。
- `final_review`：所有当前 Task Review 有效后执行整体复核。
- `completed`：Final Review 已接受，报告和归档已成功。
- `failed`：当前命令已安全停止；是否可恢复由 ErrorRecord 决定。
- `abandoned`：用户显式放弃。

正常转换：

```text
planning → running | failed | abandoned
running → planning | final_review | failed | abandoned
final_review → planning | completed | failed | abandoned
```

只有 `resume` Use Case 可以根据合法恢复点执行：

```text
failed → planning | running | final_review
```

`completed` 和 `abandoned` 是终态。

---

## 9. Execution 与 Candidate

### 9.1 Execution 职责

Execution Agent：

- 读取当前 Task、相关 Requirement、架构约束和 Review Findings。
- 按需读取完整 SPEC 和仓库资料。
- 实现或修复当前 Task。
- 运行开发期检查。
- 报告 changed scopes 和未解决 Issue。
- 不得返回 `completed` 或最终 `satisfied` 裁决。

### 9.2 TaskExecutionResult

```json
{
  "decision": "implementation_ready",
  "summary": "非空摘要",
  "proposedEvidence": [],
  "issues": [],
  "changedScopes": ["labels.readability"],
  "replanReason": null
}
```

`decision`：

- `implementation_ready`
- `failed`
- `replan_required`

### 9.3 Candidate 创建

Execution 返回 `implementation_ready` 后，系统必须：

1. 校验 SPEC、Plan 和运行分支没有变化。
2. 校验工作树不变量。
3. 为本次阶段分配稳定 `operationId`。
4. 原子更新 `state.json.activeOperation` 后才允许产生外部副作用。
5. 创建带 `Apex-Operation` trailer 的 Candidate Checkpoint。
6. 从 Git 事实计算 normalized `changedPaths`。
7. 保存 Session Record。
8. 原子提交新 `state.json`，将 Task 转为 `review_pending` 并清除 `activeOperation`。
9. 运行影响分析。

Checkpoint 信息必须包含 `candidate` 语义。Review 前不得称为完成提交。

### 9.4 Review 反馈

Review 返回 `changes_required` 后，下一次 Execution 必须获得：

- 最新 Findings 和开放 Issue。
- 未满足的 criterion。
- Reviewer 引用的 Evidence 和命令事实。
- 当前 Review Subject。
- 上次 Candidate 和当前 HEAD。

不得只提供自然语言摘要。

修复循环受 Run Budget 约束。每次修复必须针对新的 Findings 或新 Evidence；连续 Candidate 没有缩小开放问题时返回 `TASK_REVIEW_STALLED`，不得机械循环。

---

## 10. Evidence 与 Verification

### 10.1 EvidenceRecord

```json
{
  "evidenceId": "EVID-...",
  "runId": "RUN-...",
  "operationId": "OP-...",
  "taskId": "TASK-001",
  "criterionIds": ["AC-TASK-001-01"],
  "reviewedHead": "git-oid",
  "kind": "command",
  "producer": {
    "type": "orchestrator",
    "sessionId": null,
    "toolId": "verification",
    "toolVersion": "..."
  },
  "summary": "非空、已脱敏",
  "data": {
    "resolvedExecutable": "C:/Program Files/nodejs/npm.cmd",
    "argv": ["npm", "test"],
    "workingDirectory": ".",
    "exitCode": 0,
    "timedOut": false,
    "network": "deny"
  },
  "artifacts": [],
  "capturedAt": "RFC3339"
}
```

允许的 `kind`：

- `command`
- `repository_fact`
- `image`
- `measurement`
- `ocr`
- `manual_attestation`
- `document`

### 10.2 类型化数据

Evidence Schema 必须按 `kind` 使用判别联合，不允许无约束 `data`。

| kind | 必需事实 |
|---|---|
| command | resolved executable、argv、cwd、exit code、开始/结束时间、timeout、网络策略、脱敏输出和截断标记 |
| repository_fact | Git OID、normalized path、文件哈希、查询方法和结果 |
| image | 文件 SHA-256、像素尺寸、生成命令或工具、视口、DPR、数据条件和 reviewedHead |
| measurement | 数值、单位、阈值、比较规则、方法、样本和环境条件 |
| ocr | 输入图片哈希、目标文本、识别文本、置信度、阈值和通过规则 |
| manual_attestation | 用户 verdict、观察、环境条件和 reviewedHead |
| document | 文件路径、哈希、支持的 criterion 和提取方法 |

Artifact 必须记录相对存储路径、SHA-256、媒体类型和字节数。

### 10.3 Evidence Store

- Record 和 Artifact 写入后不可修改。
- Evidence 先写入并校验，再由 `state.json.evidenceIndex` 引用。
- Evidence 已写但状态尚未引用时视为 orphan，不参与 Review；恢复或归档时可安全清理。
- `state.json` 保存 Evidence ID、Record 路径、Record 哈希和 reviewedHead。
- Evidence 不提交到目标仓库 Git，但随 Run 归档。
- 单个 Artifact、单项输出和每个 Run 的 Evidence 总量受 Run Budget 约束。
- 超限返回 `EVIDENCE_BUDGET_EXCEEDED`，不得静默删除关键事实。

### 10.4 VerificationPort

Verification 必须：

- 在 `reviewedHead` 的隔离工作区执行。
- 隔离工作区创建后，系统按 Plan 的 `workspaceProvision` 声明准备依赖：默认从 Run 工作区以硬链接或复制同步依赖目录（如 `node_modules`）；需要网络安装的命令必须在 Plan 中显式声明并获得 §5.2 网络策略批准。未声明 provision 时命令因依赖缺失而失败的，按真实退出事实记录，不得粉饰。
- 使用 argv 数组和 `shell: false`。
- 通过 SandboxPort 和 CommandPolicyPort。
- 使用 Windows 隐藏窗口。
- 有界收集并脱敏 stdout/stderr。
- 不自动重试。
- 记录真实退出事实。
- 结束后确认进程树退出并销毁隔离工作区。

Review 前，系统运行当前 criterion 要求的 Plan 命令。

Reviewer 需要额外事实时返回：

```json
{
  "decision": "verification_required",
  "verificationRequests": [
    {
      "criterionIds": ["AC-TASK-001-01"],
      "commandId": "VC-TASK-001-01",
      "reason": "需要当前 HEAD 上的回归事实"
    }
  ]
}
```

- 请求优先引用 Plan command catalog。
- 新命令必须使用受控工具 ID；不得直接返回任意 argv 并自动执行。
- 需要新增权限时必须请求用户批准。
- Evidence 采集完成后启动新的 Task Review Session，历史无结论 Review 保留。

### 10.5 视觉 Evidence

允许自动界面验证时，`VisualEvidencePort` 负责受控启动、截图、OCR 和测量，并记录完整生成条件。

实现约束：

- 浏览器截图必须驱动系统已安装的浏览器（如 Chrome/Edge 无头模式与调试协议）；实现及其生产依赖闭包不得引入浏览器下载、postinstall 脚本或原生扩展，纳入前必须通过 `scan-forbidden` 验证。
- OCR 引擎必须是纯 JS/WASM 实现并通过同一依赖门禁；无法通过时实现必须省略 `ocr` Evidence kind，视觉 criterion 改用 `image` 加 `measurement` 或 `manual_attestation`，不得静默降低已接受 Plan 的 Evidence Policy。
- 截图、OCR 与测量进程同样受 §5.2 沙箱和进程树边界约束。

目标仓库说明禁止自动浏览器或界面测试时：

- 系统不得启动浏览器或开发服务器。
- 对应 criterion 必须使用 `manual_attestation`。
- 缺少人工证据时返回可恢复错误 `MANUAL_VERIFICATION_REQUIRED`。
- 不得把缺失人工证据降级为非阻断 Issue。

### 10.6 禁止作为充分证据

以下内容不得单独证明 criterion 满足：

- 无 Artifact 的“我目视确认通过”。
- 对象、测试或代码行数量。
- 源码中存在字符串。
- 非背景像素或未区分来源的亮色像素数量。
- Execution 自己书写的测试结果。
- 已删除且不可复现的临时脚本。
- 参考项目或历史 Run 的通过结论。
- 与当前 `reviewedHead` 不一致的 Evidence。

### 10.7 人工证据

新增：

```text
ApexCodingAgent attest <attestation-json-path>
```

```json
{
  "runId": "RUN-...",
  "taskId": "TASK-001",
  "criterionId": "AC-TASK-001-01",
  "reviewedHead": "git-oid",
  "verdict": "satisfied",
  "observation": "默认视口下目标文字可辨认",
  "conditions": {
    "viewport": "1920x1080",
    "scale": "100%"
  },
  "artifactPaths": ["C:/evidence/default-view.png"]
}
```

规则：

- `verdict` 只能为 `satisfied | not_satisfied`。
- 命令必须由用户在 Claude Session 外显式执行。
- 系统生成 Evidence ID、时间和 producer 权威字段。
- Run、Task、criterion 和 reviewedHead 必须匹配当前恢复点。
- Artifact 必须复制到 Evidence Store 并校验。
- `attest` 只导入事实，不直接改变 Task 状态。
- 导入成功后由用户执行 `resume`。

---

## 11. Issue

使用统一 `IssueRecord` 表达已观察问题和未消除风险：

```json
{
  "issueId": "ISSUE-...",
  "type": "finding",
  "severity": "P1",
  "blocking": true,
  "status": "open",
  "criterionIds": ["AC-TASK-001-01"],
  "scopes": ["labels.readability"],
  "paths": ["src/labels.ts"],
  "title": "默认视口文字不可读",
  "description": "实际观察到字形为占位矩形",
  "requiredAction": "替换真实字形并重新验证",
  "reportedBy": "task-review",
  "reportedAtHead": "git-oid",
  "evidenceIds": ["EVID-..."],
  "resolution": null
}
```

`type`：

- `finding`：已经观察到的缺陷。
- `risk`：尚未消除的不确定性或潜在影响。

`status`：

- `open`
- `resolved`
- `accepted`

规则：

- `resolved` 必须记录解决 Head、Evidence 和批准者。
- `accepted` 只允许非阻断 risk，并记录用户或 Reviewer 的明确理由。
- finding 不允许通过 `accepted` 规避修复。
- P0 不允许 accepted。
- open blocking Issue、open P0/P1 finding 必须阻止 Task 和 Final Review。
- Issue 引用的路径、scope 或 Evidence 失效时，其 resolution 必须重新检查。
- Execution 不得自行关闭或接受 Issue。

---

## 12. 独立 Task Review

### 12.1 ReviewSubject

初次 Review 和失效重验使用同一显式对象：

```json
{
  "reviewKind": "initial",
  "taskId": "TASK-001",
  "implementationCheckpoint": "git-oid",
  "reviewedHead": "git-oid",
  "baselineCheckpoint": "git-oid",
  "trigger": null
}
```

`reviewKind`：

- `initial`：复核当前 Task 新产生的 Candidate。
- `revalidation`：在后续变更形成的新 HEAD 上重新验证历史 Task。

Revalidation 时：

- `implementationCheckpoint` 保持该 Task 的 Accepted/Candidate OID。
- `reviewedHead` 是包含后续变更的当前 HEAD。
- Evidence 必须绑定 `reviewedHead`。
- `trigger` 必须记录来源 Task、Candidate、paths 和 scopes。

### 12.2 输入

Task Review 必须获得：

- SPEC 和 Plan Snapshot 的路径与哈希。
- 当前 Task、criterion 和相关 requirement。
- ReviewSubject。
- baseline 到 reviewedHead 的 Git diff 事实。
- 当前 reviewedHead 的 Verification Evidence。
- 开放 Issue。
- 受影响的历史 criterion。
- 以前 Review Findings。
- 权限策略和 Evidence 索引。

### 12.3 独立性与只读

- 使用新的 Session ID。
- 不续接 Execution transcript。
- 使用 reviewedHead 的只读隔离工作区。
- 先检查 requirement、diff 和 Evidence，再读取 Execution summary。
- Reviewer 不得修改、暂存或提交任何仓库文件。
- 沙箱拒绝写操作时记录安全事件，但不污染 Run 工作树。

### 12.4 Review 要求

Reviewer 必须检查：

1. 架构、数据流、状态流和模块边界。
2. diff 是否符合 Task，是否出现无关扩张。
3. 每项 criterion 是否满足 Evidence Policy。
4. Evidence 是否证明 statement 本身。
5. Issue 是否与 criterion 冲突。
6. 测试是否验证用户结果，而非只锁定实现常量。
7. 是否引入临时 patch、重复逻辑、巨型函数或跨层耦合。
8. 是否引入占位、fallback、legacy 或未声明人工步骤。
9. 是否应 replan，而非继续局部修补。
10. Revalidation 涉及的历史 criterion 在 reviewedHead 上是否仍成立。

视觉 criterion 必须满足固定生成条件，阈值必须来自 SPEC、用户批准基线或 Plan Review 的可复算结论，不得根据当前输出反向调阈值。

### 12.5 TaskReviewResult

```json
{
  "decision": "accepted",
  "summary": "非空摘要",
  "subject": {},
  "criterionVerdicts": [
    {
      "criterionId": "AC-TASK-001-01",
      "status": "satisfied",
      "evidenceIds": ["EVID-..."],
      "reason": "证据如何支持结论"
    }
  ],
  "issues": [],
  "reviewFootprint": {},
  "verificationRequests": [],
  "replanReason": null,
  "userQuestions": []
}
```

`decision`：

- `accepted`
- `changes_required`
- `verification_required`
- `replan_required`
- `user_input_required`

`accepted` 必须同时满足：

- 所有 blocking criterion 为 `satisfied`。
- 每个 verdict 满足 Evidence Policy。
- 所有阻断 Verification 成功。
- 没有 open blocking Issue 或 open P0/P1 finding。
- Evidence reviewedHead 与 ReviewSubject 一致。
- Reviewer 工作区保持只读。

非阻断 criterion 或 Verification 可以失败，但必须形成非阻断 Issue，并在报告中显示。

### 12.6 ReviewFootprint

```json
{
  "reviewId": "REVIEW-...",
  "subject": {},
  "criterionIds": ["AC-TASK-001-01"],
  "scopes": ["labels.readability"],
  "paths": ["src/labels.ts"],
  "dependencyFacts": [],
  "evidenceIds": ["EVID-..."],
  "reviewSessionId": "uuid",
  "reviewerModel": "...",
  "promptHash": "...",
  "policyHash": "...",
  "acceptedAt": "RFC3339"
}
```

`dependencyFacts` 记录 Review 结论依赖的外部事实：

```json
{
  "kind": "file_hash",
  "path": "package-lock.json",
  "hash": "sha256-...",
  "note": "依赖版本事实"
}
```

- `kind`：`file_hash`、`tool_version`、`config_value`。
- 失效判定时按 kind 重新采集并比对，变化即失效（§13.2 条件 3）。

`paths` 必须使用 Windows 大小写不敏感、正斜杠、Git 相对路径的统一规范；rename 同时记录旧路径和新路径。

---

## 13. Review Invalidation

### 13.1 失效输入

Impact Analyzer 使用：

- Git Adapter 计算的 normalized changed paths。
- Plan 中显式定义的 scope graph。
- 当前 Task 的 `mayAffectScopes`。
- Review Footprint 的 paths、scopes 和 dependency facts。
- Evidence 依赖的文件哈希。
- Reviewer 显式声明的影响。

模型自由文本 `changedAreas` 不得作为确定性输入。

### 13.2 失效条件

满足任一条件时，历史 completed Task 转为 `review_pending`：

1. changed path 与 Footprint path 相交。
2. `mayAffectScopes` 通过 scope graph 到达 Footprint scope。
3. dependency fact 的文件、配置、生成物或工具版本变化。
4. Evidence 依赖的文件哈希变化。
5. Reviewer 明确声明旧 criterion 受影响。
6. 出现 Plan 未声明且无法安全归类的全局路径变更。判据：变更路径不在任何 scope 的 paths 集合内，且属于仓库根配置、构建或 CI 配置、包管理清单或全局工具链版本文件；一律按影响全部有效 Review 保守处理。

SPEC 哈希变化不走普通失效流程，必须直接回到 Planning。

### 13.3 重验顺序

新 Task 产生 Candidate 后：

1. 以新 Candidate 为当前 reviewedHead。
2. 计算受影响的 completed Task。
3. 按依赖拓扑顺序对旧 Task 创建 `revalidation` ReviewSubject。
4. 旧 criterion 全部重新 accepted 后，Review 新 Task。
5. 任一旧 criterion 不成立时，新 Task 不得完成，必须修复或 replan。

每次失效必须记录来源 Task、Candidate、criterion、paths、scopes 和时间。

频繁失效的共享文件只产生架构指标，不自动生成 Finding。Reviewer 必须结合模块职责判断是否需要拆分，不能用固定次数替代架构分析。

---

## 14. Final Review

### 14.1 进入条件

必须全部满足：

- 当前 Plan 的 Task 均为有效 `completed` 或合法 `skipped`。
- 不存在 executing、review_pending 或 reviewing。
- 所有 Review Footprint 已在当前 HEAD 接受；失效由 §13 即时触发，进入 final_review 前不存在已过期但未发现的 Review。
- 没有 open blocking Issue 或 open P0/P1 finding。
- Plan、state、Evidence 索引和 Git HEAD 一致。
- Run Budget 尚未阻止 Final Review。

### 14.2 输入与上下文

Final Review Session 必须完整读取 SPEC，但 Prompt 不内联所有历史正文。

系统只注入：

- SPEC、Plan、仓库、分支和 HEAD 索引。
- Task、Accepted Checkpoint、Review ID 和 reviewedHead。
- criterion 与 Evidence Record 路径。
- Issue 索引。
- final verification command catalog。
- 失效和 revalidation 索引。

Reviewer 按需读取具体文件，避免长 Prompt 稀释关键约束。

### 14.3 Review 要求

Final Reviewer 必须：

1. 从当前仓库事实独立判断。
2. 检查整体架构、数据流、状态流和模块边界。
3. 检查 requirement trace 是否闭合。
4. 抽查高风险 Evidence 和 Revalidation。
5. 运行 final verification。
6. 检查跨 Task 组合行为和默认用户路径。
7. 检查人工 criterion、开放 Issue 和发布约束。
8. 不修改业务代码。

### 14.4 FinalReviewResult

`decision`：

- `accepted`
- `replan_required`
- `user_input_required`

不设 `changes_required` 是有意为之：Final Review 不进入局部修复循环，任何实现或架构缺口一律经 Plan Revision 生成修复 Task，防止终审退化为绕过 Task Review 的补丁通道。

`accepted` 必须：

- 精确列出全部有效 completed Task 和 Review ID。
- 引用 final verification Evidence。
- 不存在失败的阻断命令、缺失人工证据或阻断 Issue。
- 绑定当前 HEAD。

Final Review 是只读结论，不创建无代码变更的 Git 提交。

发现实现或架构缺口时：

- 返回 `replan_required`。
- 保存 Issue。
- Run 回到 planning。
- 相关 Review 按 path/scope 失效。

基础设施错误必须进入可恢复 failed，不得伪装成产品 Review 不通过。

---

## 15. 持久化、幂等与恢复

### 15.1 单一提交点

`state.json` 是可变运行事实的唯一提交点。任何阶段开始前，系统先原子写入：

```json
{
  "activeOperation": {
    "operationId": "OP-...",
    "stage": "task_checkpoint",
    "taskId": "TASK-001",
    "expectedHead": "git-oid",
    "sessionId": null,
    "startedAt": "RFC3339"
  }
}
```

阶段完成后一次性提交新状态并清除 `activeOperation`。

### 15.2 外部副作用协调

- Git Candidate 必须包含稳定 operation ID trailer。
- Evidence Record 必须包含 operation ID。
- Session Record 文件名和内容必须包含 operation ID。
- 报告必须从已接受状态确定性生成。

崩溃后：

- 若 Git、Session 或 Evidence 中已存在相同 operation ID，resume 必须采纳并继续提交状态，不得重复副作用。
- 若不存在对应副作用，可以从同一阶段重试。
- 若发现多个互相冲突的副作用，返回 `OPERATION_RECONCILIATION_FAILED`。
- 未被 state 引用的 immutable 文件视为 orphan，不得自动解释为成功结果。

### 15.3 ErrorRecord

```json
{
  "errorCode": "CLAUDE_PROCESS_START_FAILED",
  "stage": "task_review",
  "recoveryAction": "retry_stage",
  "operationId": "OP-...",
  "taskId": "TASK-001",
  "sessionId": null,
  "reviewedHead": "git-oid",
  "requiredAction": "执行 ApexCodingAgent resume"
}
```

`recoveryAction`：

- `retry_stage`
- `reexecute_task`
- `provide_user_input`
- `not_recoverable`

恢复点必须由 ErrorRecord、activeOperation、Task 状态、Git 和 immutable artifact 共同验证，不能只保存自然语言。

错误码注册表（实现必须集中登记，不得使用临时字符串）：

| errorCode | errorClass | 默认 recoveryAction |
|---|---|---|
| `CLI_USAGE_INVALID` | usage | not_recoverable |
| `ABANDON_REQUIRES_FORCE` | usage | not_recoverable |
| `SETTINGS_INVALID` | preflight | not_recoverable |
| `STATE_FORMAT_INVALID` | state | not_recoverable |
| `OPERATION_RECONCILIATION_FAILED` | state | not_recoverable |
| `SANDBOX_UNAVAILABLE` | infrastructure | retry_stage |
| `CLAUDE_PROCESS_START_FAILED` | infrastructure | retry_stage |
| `CLAUDE_SESSION_FAILED` | infrastructure | retry_stage |
| `PLAN_REVIEW_BUDGET_EXCEEDED` | budget | provide_user_input |
| `TASK_REVIEW_STALLED` | budget | provide_user_input |
| `EVIDENCE_BUDGET_EXCEEDED` | budget | provide_user_input |
| `MANUAL_VERIFICATION_REQUIRED` | user_input | provide_user_input |

- `errorClass` 枚举：`usage`、`preflight`、`state`、`infrastructure`、`budget`、`user_input`。
- errorCode → errorClass 是确定的静态映射；CLI 只输出已脱敏的稳定 errorCode，不透传工具原始退出码。
- resume 在用户清除阻断条件后，按崩溃窗口分析将 `retry_stage` 精确化为 `reexecute_task`（例如 Execution 阶段中断且无可用 Candidate）。
- 新 errorCode 必须先登记入表并同步测试，不得在使用处临时引入。

### 15.4 恢复规则

- 不自动重试。
- 只有用户执行 `resume` 才继续。
- 从准确阶段继续，不重跑有效 completed Task。
- Candidate 已存在时不得重复执行实现。
- Final Review 已 accepted 后报告失败，不得重新调用 Reviewer。
- manual attestation 或 user decision 缺失时，只有匹配输入导入后才允许 resume。
- 前台中断、Session 启动/流失败、Verification 启动失败、报告和归档失败必须支持准确恢复。
- 状态与副作用无法确定性协调时不得猜测。

### 15.5 Prompt 传输

- 所有 Claude Prompt 通过 stdin。
- argv 只包含控制参数。
- 必须有超过 32,767 字符 Prompt 的 Windows 集成测试。
- 不得通过截断 Prompt 规避长度问题。

### 15.6 存活性、单实例与中断

- 前台运行每 5 秒向 `heartbeat.json` 原子写入存活信号（进程启动时间、Run ID、当前阶段）。
- `start` 启动前检查 heartbeat：同名 Run 的 heartbeat 未过期（30 秒内有更新）时视为仍有活动进程，拒绝启动并按启动前置校验失败退出（退出码 3）；heartbeat 过期判定旧进程已崩溃，`start`/`resume` 可以接管。
- `status`、`report` 是只读命令，不修改状态，可以与前台运行并存。
- 第一次中断信号（Ctrl+C）：停止调度新阶段，当前阶段到达最近提交点或安全取消后写入 ErrorRecord，以退出码 `130` 结束；第二次中断：立即退出，不等待。
- 中断退出码 `130` 优先于失败退出码 `1`。

---

## 16. Context 与 Run Budget

### 16.1 Context Bundle

- Planning 和 Final Review 必须读取完整 SPEC。
- Execution 和 Task Review 默认注入当前 Task、相关 requirement、全局约束摘要、必要架构引用和历史 Findings。
- Agent 可以按需读取完整 SPEC 和仓库文件。
- Prompt 必须优先使用稳定文件路径、ID 和索引，不复制长 Evidence 正文。
- Session 交接依赖持久化结构化 Artifact，不依赖 transcript 记忆。

### 16.2 Run Budget

Run 开始时必须从 `.apex-coding-agent/settings.json` 的 `budget` 对象解析显式预算（CLI 标志可以对单次 Run 覆盖），未知字段与类型错误按 `SETTINGS_INVALID` 失败。至少覆盖：

- Plan repair 次数。
- 每个 Task 的 Candidate 次数。
- 额外 Verification 轮次。
- Session 总数和单 Session timeout。
- Verification 总时间。
- Evidence 字节数。
- 运行总时长。

运行时能够提供 Token 或成本事实时，CLI 必须同时显示并允许配置预算。

预算耗尽：

- 不得静默增加或自动循环。
- 必须保存准确恢复点和未完成原因。
- status 和报告必须显示消耗量、限制和最后有效结果。

---

## 17. CLI、进度与报告

### 17.1 CLI

保留：

```text
start
resume
status
report
abandon --force
```

新增：

```text
attest <attestation-json-path>
answer <user-decision-json-path>
```

`answer` 导入 Plan Review、Task Review 或 Final Review 请求的结构化用户决定。导入本身不直接完成任何状态。

### 17.2 进度

status 至少显示：

```text
Candidate       8/10
Task Review     7/10
待重新复核      1
等待用户输入    0
Final Review    未开始
Run 状态        执行中
预算            Candidate 8/20 · Session 17/40
```

- Final Review 未接受前不得显示整体完成或整体 100%。
- Task 行显示状态、Candidate、Accepted Checkpoint、reviewedHead、Review 次数、最新 Issue 和失效原因。
- 可恢复失败必须显示准确命令和所需输入。

退出码：

- Run 完成：`0`
- start/resume 后 Run 为 failed：`1`
- 用法错误：`2`
- 启动前置校验失败：`3`
- 查询、attest、answer 或命令级失败：`4`
- 前台中断：`130`

不得透传 Claude、Git 或 Verification 原始退出码。

### 17.3 Report

最终报告必须包含：

1. Run 结论、当前 HEAD 和 Final Review。
2. Plan Review 与 requirement coverage。
3. 每个 Task 的 Candidate、Accepted Checkpoint、reviewedHead 和 Review 结论。
4. 被拒 Candidate、Issue 和修复历史。
5. Review Invalidation 和 Revalidation。
6. 每个 criterion 的最终 verdict 与 Evidence ID。
7. Verification 命令事实。
8. 人工证据和用户决定。
9. Budget 使用情况。
10. 失败或未完成原因。

报告不得把 pending、not_run、缺失人工证据、非阻断失败或 Execution summary 写成通过。

---

## 18. Git 与工作区规则

- Execution 在专用 Run Branch 工作。
- Candidate 是唯一由 Task 实现产生的业务提交类型。
- Accepted 是状态身份，不要求额外空提交。
- Reviewer 和 Verification 使用 reviewedHead 的隔离工作区。
- Reviewer 工作区只读。
- Verification 工作区可以产生忽略文件和 Evidence 临时输出，结束后整体销毁。
- changed paths 必须由 Git Adapter 从 OID 差异计算。
- Git commit、Evidence 和 Session 通过 operation ID 关联。
- 系统不得修改用户原分支，不得自动 push。
- Run 进入终态后归档到 `history/<runId>/`：state、Plan Snapshot、Evidence Record 与 Artifact 索引、Session Record 和 report.md；归档写入成功是 `completed` 的必要条件。
- 系统不自动合并 Run 分支；报告输出 Run 分支名与最终 HEAD，合并、挑选或丢弃由用户决定。

---

## 19. Prompt 规范

### 19.1 Planning

必须要求：

- 主动寻找需求矛盾和不可行数值。
- 参考实现不构成当前证据。
- 规划高风险纵向里程碑。
- 为 criterion 定义 Evidence Policy。
- 区分 deliverable、global constraint 和 user decision。
- 禁止普通 Task 承担 Final Review。

### 19.2 Plan Review

采用尝试否证计划的审查姿态，检查遗漏、错误依赖、尺度矛盾、伪验收、参考实现锚定和无人负责的组合结果。

### 19.3 Execution

明确：

- 只能产出 Candidate。
- open blocker 不得包装成普通风险。
- 发现计划错误必须 replan。
- 不得生成假人工证据。
- 不得通过修改测试掩盖失败。

### 19.4 Task Review

明确：

- 先看 requirement、diff 和 Evidence，再看 Executor summary。
- 目标是寻找反例。
- Issue 与 criterion 冲突时不得 accepted。
- 不得修改业务代码。
- Evidence 必须证明目标本身并绑定 reviewedHead。

### 19.5 Final Review

明确：

- Task Review 可以被推翻。
- 默认用户路径和跨模块组合优先于局部结构存在。
- 未验证不等于通过。
- 不得直接修复后自我批准。

Prompt 约束只能指导模型；权限、状态转换和完成门槛必须由代码强制。

---

## 20. 测试与 Agent 评估

### 20.1 自动化测试

Domain 测试必须覆盖：

- Task/Run 全部合法和非法转换。
- Candidate、Accepted、reviewedHead 的区别。
- Evidence Policy 的 `allOf/anyOf`。
- Issue 阻断和 resolution。
- initial/revalidation ReviewSubject。
- path/scope/dependency 失效。
- Final Review 前置条件。
- activeOperation 与恢复不变量。
- requirement trace 和 Plan Revision ID 规则。

Application/Adapter 测试必须覆盖：

- Execution 只能产生 Candidate。
- Verification 失败不能被模型陈述覆盖。
- verification_required 循环。
- Review feedback、replan 和 user input。
- 隔离工作区、命令策略、环境允许列表和网络拒绝。
- Evidence 类型、哈希、预算和脱敏。
- Prompt stdin 和长 Prompt。
- operation ID 副作用协调。

集成/E2E 必须覆盖：

1. 完整 happy path。
2. Plan changes_required 和 user_input_required。
3. Task changes_required、verification_required 和 replan_required。
4. Executor 声称成功但真实命令失败。
5. 不可读风险与可读 criterion 冲突。
6. 亮色像素不能证明文字可读。
7. 后续 Task 使历史 Review 失效并在新 HEAD 重验。
8. Session、Git、Evidence、state 各崩溃窗口的幂等恢复。
9. Reviewer 写操作被启动前边界阻止。
10. 未授权命令、网络和凭据访问被拒绝。
11. 人工 attestation 和 user decision 导入后准确恢复。
12. Final Review 未接受时进度不显示完成。
13. heartbeat 未过期时 `start` 拒绝启动；过期后 `resume` 可接管。
14. 第一次中断安全收尾并以 130 退出，第二次中断立即退出。

### 20.2 测试质量

- 行为测试优先，不用大量源码字符串断言替代。
- 常量测试必须同时证明外部目标。
- 视觉阈值来自 SPEC 或批准基线。
- 失效测试必须同时覆盖应失效和不应失效，防止单向过拟合。
- Fake Claude 用于验证编排确定性，不用于证明真实模型 Review 质量。

### 20.3 真实模型评估

发布前必须运行独立于 `npm test` 的真实模型评估集，使用真实失败案例和对抗样本，记录：

- 模型、CLI、Prompt 和策略版本。
- 多次 trial 的 false accept、false reject 和完成率。
- 平均 Candidate、Review、Session、时间和 Token。
- prompt injection、权限请求和错误恢复表现。
- Invalidation 放大率。

模型或 Prompt 发生实质变化时必须重跑评估。评估失败不得通过修改阈值或删除困难样本掩盖。

发布基线：

- 首次评估通过后，指标与评估集版本固化为基线文件随仓库保存。
- 发布门槛：china-3d 三类核心假阳性场景的 false accept 必须为 0；整体 false accept 率不得高于基线；完成率不得低于基线。
- 基线只能随评估集版本升级整体重估，不得为通过单次发布而局部放宽。

---

## 21. 验收标准

### AC-001：独立计划复核

Plan 未通过独立 Plan Review 前，不得进入 running。

### AC-002：Candidate 与完成分离

Execution 成功后 Task 必须为 review_pending，不存在 Execution 直接完成路径。

### AC-003：Review Subject 正确

初次 Review 和 Revalidation 都明确区分 implementationCheckpoint 与 reviewedHead；Evidence 绑定 reviewedHead。

### AC-004：Evidence Policy

每个 blocking criterion 必须满足结构化 `allOf/anyOf` Evidence Policy。

### AC-005：真实命令事实

VerificationPort 的退出事实不能被模型自述覆盖。

### AC-006：安全执行

Reviewer 写操作、未授权命令、未批准网络和凭据环境在技术边界上被拒绝。

### AC-007：Issue 阻断

open blocking Issue 或 open P0/P1 finding 存在时，Task 和 Final Review 不能 accepted。

### AC-008：影响失效与重验

path、scope 或 dependency 相交时，历史 Review 失效并在新 HEAD 上按依赖顺序重验。

### AC-009：Final Review 唯一门槛

没有 Final Review accepted 时 Run 不得 completed，也不得显示整体完成。

### AC-010：幂等恢复

Git、Session、Evidence 或 state 任一提交边界崩溃后，resume 不重复已发生副作用。

### AC-011：人工决定闭环

缺少 attestation 或 user decision 时如实失败；匹配输入导入后只恢复准确阶段。

### AC-012：上下文与预算

Task Session 使用索引化 Context Bundle，所有质量循环受显式 Run Budget 约束。

### AC-013：可审计报告

报告能定位每个 criterion、Evidence、ReviewSubject、Issue、Invalidation 和 Budget 事实。

### AC-014：架构守护

Domain/Application 不依赖外层或 `node:*`，新增能力全部通过 Port 注入。

### AC-015：完整门禁

build、typecheck、Vitest、架构守护、禁用项扫描、安全测试、崩溃恢复测试和发布前真实模型评估全部通过。

---

## 22. 实施顺序

1. 重构当前巨型 Use Case 和 Run Driver，建立清晰阶段边界。
2. 定义 `state.json` 聚合、activeOperation 和幂等协调。
3. 定义 Plan、Requirement Trace、Evidence Policy、ReviewSubject 和 Issue。
4. 实现 SandboxPort、CommandPolicyPort 和隔离工作区。
5. 实现类型化 Evidence、Verification 和人工导入。
6. 实现 Candidate、Task Review 和反馈循环。
7. 实现 Impact Analyzer 与 Revalidation。
8. 实现 Plan Review 和 user decision。
9. 实现 Final Review、Context Bundle 和 Run Budget。
10. 更新 CLI、Report、归档、README 和测试。
11. 建立真实模型评估集并形成发布基线。

任何阶段发现现有结构无法保持高内聚、低耦合时，必须先重构，不得继续向 `execute-next-task.ts`、`run-final-review.ts` 或单个 Prompt 文件堆叠逻辑。

---

## 23. 完成定义

本 SPEC 的实现只有在以下条件全部满足时才算完成：

1. AC-001 至 AC-015 全部有自动化或明确人工证据。
2. `npm test` 全绿。
3. 安全、崩溃恢复和长 Prompt 集成测试通过。
4. 至少一个 E2E 完整走过 Plan Review、Execution、Task Review、Invalidation、Revalidation、Final Review 和 Report。
5. `china-3d` 的三类核心假阳性有回归测试：
   - 已知不可读 Issue 不能 completed。
   - 亮色像素不能证明文字可读。
   - Final Review 未运行不能显示 Run 完成。
6. 任一已发生外部副作用都能通过 operation ID 幂等协调。
7. 真实模型评估达到 §20.3 发布基线（首次实施时建立基线并通过）。
8. 没有兼容、迁移、fallback、deprecated、重复完成判定、隐式权限扩大或模型自证捷径。

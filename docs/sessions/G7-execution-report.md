# G7 执行报告 — 发布矩阵与性能验收

> 执行日期：2026-07-28。执行方式：本机（Windows 11 桌面版）人工驱动，按 `G7-release-ci.md` 清单逐项执行。
> 规则遵循「完成定义」：无法执行的项**显式记录为未通过/偏差**，不静默省略。

## 执行环境

| 项 | 值 |
|---|---|
| 机器 OS | Microsoft Windows 11 家庭中文版（桌面版），Build 26200（10.0.26200），x64 |
| CPU | Intel Core i5-14500，20 逻辑核 |
| 内存 | 16.0 GB（16,849,219,584 字节） |
| 存储 | NVMe SSD 1 TB（Get-PhysicalDisk MediaType=SSD） |
| Git | 2.53.0.windows.2 |
| Node 运行时 | 22.23.1（系统当前）、24.16.0（nvm 存储）、25.9.0（nvm 存储，用于拒绝性验证） |
| Claude Code | 2.1.220（原生 `claude.exe`，npm 全局安装于 `C:\nvm4w\nodejs`） |

## A. 发布运行矩阵（AC-024、NFR-008）

| 项 | 结果 | 证据 |
|---|---|---|
| Node.js 22.x 完整自动化测试 | ✅ 通过 | Node v22.23.1：`npm test` = build + typecheck + vitest **42 文件 / 644 测试全绿** + check-architecture OK + scan-forbidden OK |
| Node.js 24.x 完整自动化测试 | ✅ 通过 | Node v24.16.0：同套命令逐步执行（tsc×2 + vitest + 两脚本），**42 文件 / 644 测试全绿**，两扫描 OK |
| 其他 Node 主版本 → `ENVIRONMENT_UNSUPPORTED`（退出码 3） | ✅ 通过 | Node v25.9.0 在最小 Git fixture 执行 `start`：输出 `[apex] error ENVIRONMENT_UNSUPPORTED (startup_validation, stage startup): unsupported Node.js version v25.9.0; requires >=22 <23 \|\| >=24 <25`，退出码 **3**；未创建任何 Run |
| Windows 11 x64 完整测试 | ✅ 通过 | 上述两条均在本机 Windows 11 Build 26200 桌面版完成 |
| Windows 10 x64 完整测试 | ❌ **偏差（未执行）** | 本机为 Windows 11；无 Windows 10 机器/自托管 Runner。按 G7 规则显式记录为未通过项，需项目所有者决策（补 Win10 Runner 或接受偏差） |
| 发布物依赖扫描（无 .NET/C#/Rust/C++/N-API/`.node`） | ✅ 通过 | `node scripts/scan-forbidden.mjs`：「src 无禁用实现痕迹；生产依赖闭包 5 个包无原生模块」；`npm pack` 产物内 `.node/.dll/.exe` 计数为 0 |
| `npm pack` 产物检查 | ✅ 通过 | 产物 167 个条目 = 166 个 `dist/` 文件 + `package.json`，146.3 kB；`dist/interfaces/cli/main.js` 含 `#!/usr/bin/env node` shebang；解包后 `npm install --omit=dev`（仅 5 个生产包）并运行 `--help` 成功 |

### A 区观察（非失败项）

- `claude` 默认 PATH 解析在 Windows npm 全局安装下会命中无扩展名 sh shim（`shell:false` 无法启动），报 `CLAUDE_INSTALLATION_UNHEALTHY`。改用 `--claude-cli-path` 指向原生 `claude.exe` 后正常。这符合 SPEC §7.2「参数数组、禁止 shell 拼接」的设计取舍，但错误诊断未引导用户到 `--claude-cli-path`，建议后续改进提示（本报告仅记录，不改动代码）。
- 发布用 `package.json` 当前带 `"private": true`；`npm pack` 不受影响，但若计划发布到 npm registry 需移除。MVP 发布物为 tgz 产物本身，故不判失败。

## B. NFR-007 性能验收协议

测量脚本：`scripts/perf-nfr007.mjs`（新增，零依赖，复用 dist 编译产物与 ajv 校验器构造夹具）。协议逐项落实：真实 Git 仓库夹具（50 pending Task、200 历史 Execution Episode、10 Plan Revision，全部通过应用自身 Schema 校验）；每项预热 20 次、连续测量 200 次；nearest-rank P95；Claude 不进入任何样本；仅「启动检查（不含 Git）」一项使用 Fake Git Port（SPEC 明确允许）；测量前后对整个夹具树（含 .git）做 SHA-256 比对，确认启动检查路径只读。原始样本与环境摘要：`docs/sessions/g7/perf-win11-node22.json`、`docs/sessions/g7/perf-win11-node24.json`。

| 组合 | Task 选择 P95 (<100ms) | 状态读取 P95 (<500ms) | status P95 (<2s) | 启动检查(不含 Claude/Git) P95 (<2s) | 判定 |
|---|---|---|---|---|---|
| Win11 × Node 22.23.1 | 0.009 ms | 5.243 ms | 695.298 ms | 2.698 ms | ✅ PASS |
| Win11 × Node 24.16.0 | 0.010 ms | 5.162 ms | 638.300 ms | 2.494 ms | ✅ PASS |
| Win10 × Node 22.x | — | — | — | — | ❌ 偏差（无 Win10 机器） |
| Win10 × Node 24.x | — | — | — | — | ❌ 偏差（无 Win10 机器） |

硬件/平台摘要：i5-14500（20 逻辑核）、16 GB、NVMe SSD、Windows 11 Build 26200 x64（满足 ≥4 逻辑 CPU / 8 GB / SSD）。**NFR-007 判定：Win11 两组全指标通过；Win10 两组按规则记为未通过项，整体 NFR-007 因此不能宣布全通过（SPEC：任一组合不达标即未通过——此处为未执行而非不达标）。**

## C. 真实环境端到端冒烟（AC-001、AC-005、AC-006）

环境：真实 Claude Code 2.1.220（原生 `claude.exe`），经用户 Provider 配置实际由 **glm-5.2** 模型服务（session record `claude.model` 字段），Provider 凭据全程不经 Apex（AC-005 成立）。能力探测确认 `-p`、`stream-json`、`--json-schema`、`--permission-mode`(含 `auto`/`bypassPermissions`)、显式 `--session-id` 齐全。冒烟项目：仅含一个 SPEC.md（创建一个 hello.txt 文件）的最小 Git 仓库。

**run#1（RUN-4d161b86…，exit 1）**：planning 真实通过（Revision 1 提交、tasks.json + plans/1.json 快照、Session Record 完整），进入 running（AC-001/AC-003 真实成立）。Execution Session 真实执行并通过 Shell 验证创建 hello.txt，但模型把 `replanReason` 输出为**字符串 `"null"`**（应为 JSON `null`）——过了 JSON Schema（类型是 string），被 Domain 规则「decision completed requires replanReason to be null」正确拒绝 → `CLAUDE_RESULT_INVALID`，Run 按 §9.6 确定失败、不重试。判定：产品行为符合 SPEC；失败根因为 Provider 模型的 JSON 纪律，非产品缺陷。

run#1 附带验证（真实环境）：
- Execution Session 以 `permissionMode: "auto"` 启动，**未传任何限制型参数**：init 事件显示完整原生工具集（Task/Bash/Edit/Write/Skill/WebFetch…）、用户 15 个 Skills、Subagents（agents 列表）、slash commands 均可用，`mcp_servers: []`（用户未配置 MCP，符合「按用户配置可用」）→ AC-006 成立；AC-007（默认 auto）成立。
- 日志脱敏真实生效：init 事件 `apiKeySource` 落盘为 `[REDACTED]`（AC-019 真实抽验成立）。
- Run 结束后保持 Run Branch 为当前分支（`apex-coding-agent/RUN-4d161b86…`）✓；失败 Run 未形成 Checkpoint，Claude 的工作区产物（hello.txt）保留未提交，符合「不擅自提交/回滚」边界。

**run#2（RUN-534a3954…，exit 1）**：归档真实通过（run#1 全套状态+Sessions+Logs+plans 自包含入 `history/RUN-4d161b86…/`，含 archive-manifest.json → AC-023 真实成立）；随后全流程与 run#1 **完全同因**失败（`"replanReason": "null"` 字符串）——2/2 复现，确认为该 Provider 模型的系统性行为。

**§17 命令矩阵（在 run#2 终态 failed 上执行）**：
- `status` → 退出码 0，完整展示 failed Run（§17「读 failed 仍是成功读取」）✓
- `report` → 退出码 0，生成失败版 report.md：头部含「未执行独立验证」免责声明、错误码/阶段齐全、明确标注「当前 HEAD 不是成功的 Final Commit」、无凭据样内容 ✓（同时构成 D.3 的真实样本）
- `abandon`（无 --force）→ `RUN_NOT_ABANDONABLE` 退出码 4（终态门禁先于 force 门禁）✓
- `abandon --force` → `RUN_NOT_ABANDONABLE` 退出码 4 ✓
- 非终态 Run 的真实 abandon 过渡：见下方 run#3。

**run#3（RUN-0320cfc0…，真实中断 + abandon，AC-027/028）**：start 进入 planning（activeSession `d005946b…` 写入后）以 `taskkill /F` 强杀协调器进程（不给 §2.4 收尾机会），遗留非终态 Run。随后：
- `status` → 退出码 0，如实展示 planning + activeSession 接力槽（只读、不改动状态）✓
- `abandon`（无 --force）→ `ABANDON_REQUIRES_FORCE` 退出码 4 ✓
- `abandon --force` → 打印「无法判断旧进程是否存活…不终止任何进程、不修改 Git」警告后 Run → **abandoned**，退出码 0 ✓
- `status` → abandoned（终态时间、`RUN_ABANDONED_BY_USER`、activeSession 清空），退出码 0 ✓
- Git 全程零改动：HEAD 停留 `eafe2b5`、无新 Commit、分支不变（AC-028 行为级验证）✓
- 孤立的 claude.exe 子进程在协调器死亡后随管道断裂自行退出（已由 OS 用户侧确认清理，非协调器行为）

- [ ] 最小 Git 项目 `start` 进入 planning（run#1/#2 均真实通过）并完成至少一个 Task —— **❌ 未通过**：2/2 次 Execution 结果契约校验被 glm-5.2 的 `"null"` 字符串输出触发 `CLAUDE_RESULT_INVALID`；产品按 §9.6 正确拒绝并失败，根因为 Provider 模型 JSON 纪律，非产品缺陷。按 G7 规则显式记录为未通过项（换用遵守契约的 Provider 模型后需重验）
- [x] Claude 子进程直接使用当前 Provider（glm-5.2），无需 Apex 做任何凭据处理
- [x] Execution Session 中 Skills/Subagents/Plugins/Hooks 按用户配置可用（MCP 用户未配置）
- [x] `status`、`report`、`abandon --force` 各执行一次，行为与 §17 一致（含 run#3 非终态真实 abandon，见上）

## D. DoD 终检（SPEC §23）

> 方法：逐条对照 §23 清单，每条指认自动化证据（G1–G6 测试/脚本）或本报告 A/B/C 项。证据均经开文件核实，测试标题逐字引用。§22.4 追踪矩阵（28 FR / 8 NFR）与 34 个 AC 的覆盖核对同步完成。

### D.1 §23 逐条签核

| §23 条目 | 证据 | 判定 |
|---|---|---|
| 全部 FR 对应验收场景通过 | `npm test` 644 绿（Node 22/24 各一遍，见 A）；代表 `tests/interfaces/cli/process.test.ts` "start happy path exits 0; status reads completed with 0; report regenerates with 0" | 覆盖 |
| 全部 NFR 有自动化证据 | NFR-001..006/008 见 D.2 矩阵；NFR-007 实测见本报告 B 区（Win11 双版本全指标 PASS，Win10 偏差） | 覆盖 |
| 用户项目只需 SPEC 和最小外部环境 | `process.test.ts`（fixture 仅 SPEC + Fake Claude）、"startup validation failure exits 3 with the stable code and creates no run" | 覆盖 |
| 一条 start 命令生成计划并开始执行 | `process.test.ts` 单 `start` 后断言 planning→running、final_review→completed | 覆盖；C 区真实复验 |
| 主程序使用 TypeScript | `tsc` 构建 + `check-architecture.mjs` 分层扫描 | 覆盖 |
| Claude/Git 低耦合 Adapter | `check-architecture.mjs`；`tests/adapters/claude/centralization.test.ts` "raw stream-event fields are interpreted only inside adapters/claude" | 覆盖 |
| Claude 调用错误直接清晰结束 Run | `tests/e2e/failures.test.ts` "nonzero exit fails the task and the run with CLAUDE_EXIT_NONZERO; no automatic retry" | 覆盖 |
| 无 waiting/pausing/paused/canceled | `tests/domain/run-state.test.ts` "has exactly six statuses and three terminal statuses"、"terminal statuses accept no event at all" | 覆盖 |
| CLI 无 resume/pause/stop，有显式不可逆 abandon | `tests/interfaces/cli/args.test.ts` 逐字拒绝三命令；`tests/e2e/abandon-report.test.ts` "ten-step transition ... abandoned" | 覆盖 |
| Plan Revision 不破坏 completed Task | `tests/e2e/replan-and-spec-change.test.ts` "intermediate checkpoint preserved, task back to pending, revision 2 adopts it, both episodes kept" | 覆盖 |
| Replan 不遗留无人负责的中间 Checkpoint | 同上 + `tests/application/prompts.test.ts` 断言 Prompt 含接管要求 | 覆盖 |
| 每次 Execution 保留不可覆盖 Episode | `tests/domain/episodes.test.ts` "never overwrites a closed episode and rejects unknown sessions"、"keeps every episode of a task across replan cycles" | 覆盖 |
| Run Branch 和 Checkpoint 可追溯 | `tests/e2e/happy-path.test.ts` 断言 runBranch/finalCommit；`tests/integration/git/invariants.test.ts` "fails with GIT_HISTORY_DIVERGED when a completed checkpoint is unreachable" | 覆盖 |
| Base Branch 引用与受保护路径确定性校验 | `invariants.test.ts` "fails with BASE_BRANCH_REQUIRED when HEAD is detached"、PROTECTED_PATH_CHANGED 系列 | 覆盖 |
| status/report 不展示撕裂快照 | `tests/adapters/state/consistent-read.test.ts` "fails busy when run.json and tasks.json planRevisions never match"；`tests/application/generate-report.test.ts` "只读取一次一致性快照" | 覆盖 |
| Final Review 与报告闭环 | `tests/e2e/happy-path.test.ts` 全链路逐字段断言 | 覆盖；C 区真实复验 |
| completed 逐项覆盖 acceptanceCriteria | `tests/domain/results.test.ts` "completed requires every criterion satisfied and no failed test" | 覆盖 |
| 终态 Run 不因报告重生成失败改变 | `tests/e2e/abandon-report.test.ts` "a failing regeneration maps to REPORT_COMMAND_FAILED and keeps the run completed" | 覆盖 |
| 全部 Sink 不含检测到的凭据 | `tests/adapters/redaction/corpus.test.ts` 语料×sink 矩阵（5/7 sink 直接覆盖） | **部分覆盖，见缺口 D-a** |
| Node 22.x/24.x 发布矩阵 | 本报告 A 区（双版本 644 绿） | 覆盖（Win10 偏差除外） |
| 无 C#/.NET/Rust/C++/N-API 依赖 | 本报告 A 区扫描 + `pack.test.ts` 负向 fixture | 覆盖 |
| 无 Mutex/NamedPipe/JobObject/PID/Invocation/Journal/崩溃恢复/Session Resume | `scripts/scan-forbidden.mjs`；`centralization.test.ts` "no source file references --resume or process ids" | 覆盖 |
| 内置三 Prompt 与 Schema 一致 | `tests/application/prompts.test.ts` 三例（字段名/格式节文本级断言） | 覆盖（文本级，见缺口 D-c） |
| CLI 帮助、默认值与本文一致 | `process.test.ts` "--help exits 0 and matches the documented text"（逐字 + 否定断言 + snapshot） | 覆盖 |

### D.2 §22.4 追踪矩阵核对（28 FR / 8 NFR）

13 个 FR 组逐行核对，证据均真实存在且点名可查（代表：`tests/integration/git/checkpoint.test.ts` checkpoint/trailer 系列、`tests/domain/plan.test.ts` 合并与保护系列、`tests/e2e/replan-and-spec-change.test.ts` Replan 六步/五步流、`tests/e2e/archive.test.ts` 自包含幂等归档、`tests/adapters/state/consistent-read.test.ts` 双读系列）。NFR-001/004/005/006/008 行成立。例外：

- **FR-013/FR-019 行**：「运行时矩阵测试」自动化不存在（仅有版本拒绝测试与 engines 声明）——按 SPEC 归属 G7 人工协议，即本报告 A 区。⚠️ 措辞超出自动化证据，已以 A 区补齐。
- **NFR-002/003 行**：矩阵措辞含「命名规则扫描」，仓库无此实现（仅 check-architecture + scan-forbidden 两脚本，且 check-architecture 无负向 fixture）。⚠️ 记录为证据与措辞差异，待项目所有者决策。
- **NFR-007 行**：仓库无性能自动化，按 SPEC 定义由本报告 B 区产出实测。

34 个 AC 中 29 个有直接自动化证据（逐字测试标题已核对）；AC-001/005/006（真实 Claude 环境）、AC-024（发布矩阵实跑）的自动化部分为契约级证明（Fake Claude argv 数组、环境继承、不限制原生能力、版本拒绝、pack 扫描），真实环境部分由本报告 A/C 区覆盖。

### D.3 report.md 样例人工审查

- 断言过的报告样例中**无凭据样字符串**；唯一凭据串是故意的负向金丝雀（AWS 文档示例密钥注入 Episode 摘要，断言落盘前被 `[REDACTED]`）。
- 报告**不声称无证据的独立验证**：测试结果小节标题逐字归因 `## 测试结果（Claude 报告）`，模板内含「未执行独立的安全验证或进程恢复验证」免责声明；失败报告另有 "never presents the current HEAD as a successful Final Commit"。

### D.4 缺口与薄点（显式记录，不静默）

- **D-a（AC-019/FR-027）**：凭据语料×sink 矩阵直接覆盖 5/7 sink（log、console、report、Session Record、run.json）；**计划（tasks.json/plans）与归档**未直接进入矩阵。构造层面缓解：计划草稿落盘前经 `redactStructured`（`generate-plan-revision.ts:192`），归档仅复制已脱敏产物。判定：行为正确、直接证据薄，建议后续补 corpus×tasks.json / corpus×archive 用例。
- **D-b（AC-028）**：「不连接旧 Session、不终止进程」为结构性证据（abandon 用例端口注入不含进程能力），非行为断言。
- **D-c（§23 Prompt↔Schema）**：一致性为文本级断言，非程序化模板比对；reporter 免责声明行未被测试钉住（仅归因标题被断言）。
- **D-d（NFR-002/003）**：§22.4 措辞的「命名规则扫描」无实现（见 D.2）。

## 结论

按 G7「完成定义」：A–D 全部勾选才达到 SPEC §23 的 MVP Ready。**本次执行不宣布 MVP Ready**，原因与证据如上各区，未通过/偏差项汇总（全部显式记录，无静默省略）：

| # | 项 | 性质 | 后续动作（项目所有者决策） |
|---|---|---|---|
| 1 | Windows 10 x64 完整测试（A 区） | 未执行（无 Win10 机器/自托管 Runner） | 补 Win10 Runner 重跑 `npm test`，或正式接受偏差 |
| 2 | NFR-007 Win10 × Node 22/24 两组（B 区） | 未执行（同上） | 在 Win10 Runner 执行 `node scripts/perf-nfr007.mjs`（脚本已就位） |
| 3 | C 区「完成至少一个 Task」 | 未通过：Provider 模型 glm-5.2 系统性输出 `"replanReason":"null"` 字符串（2/2），触发 `CLAUDE_RESULT_INVALID`；产品按 SPEC 正确拒绝 | 换用契约合规的 Provider 模型重验 C 区；或评估对该模型族的适配（超出本版 SPEC 范围） |
| 4 | D 区薄点 D-a–D-d（语料 sink 5/7、abandon 结构性证据、Prompt↔Schema 文本级、命名规则扫描缺失） | 行为正确、直接证据薄 | 决策是否补测试/脚本，或接受现有推理链 |

已完整通过的部分：A 区 Node 22/24 双版本 644 测试 + 版本拒绝 + 依赖扫描 + pack 产物（Win11）；B 区 Win11 两组全指标 P95 达标（原始样本在 `docs/sessions/g7/`）；C 区 Provider 直用、原生能力可用、§17 命令矩阵与真实 abandon；D 区 §23 的 24 条中 20 条直接覆盖。

执行留痕：性能原始样本 `docs/sessions/g7/perf-win11-node{22,24}.json`；性能脚本 `scripts/perf-nfr007.mjs`（可重复执行）；C 区冒烟证据仓库 `.g7-fixtures/smoke/`（含三次 Run 的状态、Sessions、Logs、归档与 report.md，未跟踪，可删除）。

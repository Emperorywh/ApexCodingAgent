# G3：Git 适配器 + SPEC 发现 + Checkpoint

## 会话目标

实现 GitPort 及其 Git CLI 适配器：SPEC 发现与路径校验、exclude 管理、Run Branch、Session 前后 Git 不变量、三类 Checkpoint（Task/中间/Final Review），全部用真实临时 Git 仓库做集成测试。

## 建议的 goal 完成判据

```text
完成 docs/sessions/G3-git-spec-discovery.md 定义的 G3 交付。
判据：
1. `npm test` 全绿，包含本文档"测试清单"全部用例（真实临时仓库，含 linked worktree）。
2. G1/G2 测试保持全绿；架构扫描保持通过。
3. GitPort 不出现 push/reset --hard/clean/删分支/merge Base Branch 能力（代码评审 + 扫描）。
```

## 前置条件

G1 已通过（错误码、Schema、Domain 不变量）。不依赖 G2/G4（文件读写可先直接用 node:fs，G5 组装时统一走端口）。

## 起手读取

- 本文件、`TRACE.md` 第 4/6/9 节
- SPEC §3.1（最小目录与 exclude）、§3.2（SPEC 发现）、§8.1（git 相关检查项）、§8.3（Run Branch 与不变量）、§12 全章（Checkpoint）、§15.3（git_error 行）、§22.2（git 相关测试条目）

## 交付物

- `src/application/ports/GitPort.ts`
- `src/adapters/git/`：
  - `cli.ts`：`child_process.spawn` 参数数组封装（禁止 shell 拼接）、超时与 stderr 采集、错误 → `GIT_COMMAND_FAILED`
  - `spec-discovery.ts`：默认发现 + 显式路径校验 + SPEC 读取与 SHA-256
  - `exclude.ts`：状态目录 exclude 管理
  - `invariants.ts`：Session 前后 Git 事实校验
  - `checkpoint.ts`：三类 Checkpoint 创建
- `tests/integration/git/`：真实临时仓库集成测试

## 规范性要点

### SPEC 发现（§3.2）

- 默认发现：`git ls-files --cached --others --exclude-standard`，取文件名**严格等于** `SPEC.md` 者，排除 `.git/` 与 `.apex-coding-agent/`；不遍历 ignored 目录、不跟随符号链接/Junction；多候选 → `SPEC_AMBIGUOUS`；零候选 → `SPEC_NOT_FOUND`。
- 显式路径：以命令调用目录解析 → 绝对路径 + 真实路径（realpath）+ Windows 大小写不敏感包含校验；**词法路径与真实路径都必须**在 repositoryRoot 内（否则 `SPEC_OUTSIDE_REPOSITORY`）；规范化为 `/` 分隔 Git 相对路径。
- 文件校验：普通文件（`SPEC_NOT_REGULAR_FILE`）、可读（`SPEC_NOT_READABLE`）、UTF-8 允许 BOM（`SPEC_INVALID_UTF8`）、非空（`SPEC_EMPTY`）；SHA-256 按原始字节。
- staged SPEC → `SPEC_STAGED`（不自动 unstage）；未跟踪或仅工作区修改允许。

### exclude（§3.1）

`git rev-parse --git-path info/exclude` 定位实际文件，幂等加入 `.apex-coding-agent/`；不假设 `.git` 是目录（linked worktree 必须正确）；不修改 `.gitignore`。

### Session 前后 Git 不变量（§8.3）

每次 Session 启动前与正常结束后确认：

1. HEAD 附着于预期 Run Branch；
2. Session 开始 HEAD == `run.json.expectedHead`；
3. `baseBranchRef` 仍精确指向 `baseCommit`；
4. 所有 completed Task Checkpoint 是当前 HEAD 祖先（`merge-base --is-ancestor`）；
5. `.apex-coding-agent/` 不含任何 Git 已跟踪路径；
6. Session 新增 Commit 不包含 SPEC 或 `.apex-coding-agent/`（`diff --name-only start..HEAD`）→ 违反即 `PROTECTED_PATH_CHANGED`；
7. SPEC 不处于 staged 状态。

Planning Session 结束后额外确认：HEAD 与开始时完全相同；除 SPEC 和 `.apex-coding-agent/` 外，index、已跟踪工作区、未跟踪文件集合完全相同（用 `git status --porcelain` 快照比对）→ 违反即 `PLANNING_SIDE_EFFECT_DETECTED`，不自动回滚。

错误映射：命令失败 → `GIT_COMMAND_FAILED`；HEAD 附着/expectedHead/分支事实冲突 → `GIT_FACT_CONFLICT`；Base 引用移动或祖先校验失败 → `GIT_HISTORY_DIVERGED`。任一失败 → Run failed；不做 reset/rebase/stash/merge/clean/切分支。

### Checkpoint（§12）

- 一律 `--no-verify --no-gpg-sign`；Commit 时显式排除 SPEC 路径与 `.apex-coding-agent/`（pathspec `:(exclude)`）。
- Task Checkpoint（§12.2 共 11 步）：保留 Claude 已创建的合法 Commit，只提交剩余变更；无变更时记录原因；Message 与四行 Trailer 按 TRACE.md 第 6 节。
- 中间 Checkpoint（§12.3）：`replan_required`/SPEC 变化/Final Review replan 时；无变更显式记录 `no_intermediate_changes`；追加到 `run.json.intermediateCheckpoints` 与对应 Episode；中间 Checkpoint 不得报告为成功最终 Checkpoint。
- Final Review Checkpoint（§12.4）：completed 时保留 Claude Commit + 提交剩余；无变更时 Final Commit = Review 开始 HEAD。
- Trailer 细节：SPEC 只在 §12.2 给出完整 Trailer 块。中间/Final Review Commit 使用相同 Trailer 名集合，无对应值的行省略（如无 Task 时省略 `ApexCodingAgent-Task`）——不得创造新 Trailer 名。

## 明确不做

- Claude 调用、状态文件写入流程（G2 已提供写协议，本会话只产生 Git 事实）、归档、报告。
- 任何被 §12.6 禁止的 Git 行为。

## 测试清单

- §22.1：路径规范化（Windows 大小写、`/` 归一化）；SPEC 发现与目录排除；Git ignored 边界；符号链接/Junction 边界（无权限创建时 skip 并标注）
- §22.2：
  - 临时仓库创建 Run Branch；Claude 已创建 Commit 时保留其 Commit、只补剩余变更
  - 仓库配置失败 hook（`core.hooksPath`）与 `commit.gpgsign=true` 时 Coordinator Checkpoint 仍成功
  - 普通仓库与 linked worktree（`git worktree add`）中 exclude 幂等更新
  - Run Branch 被切换 / Base Branch 引用移动 / 历史被改写 → 对应 git_error 确定失败
  - Claude Commit 包含 SPEC 或 `.apex-coding-agent/` → `PROTECTED_PATH_CHANGED`
  - Planning 副作用（改工作区/index/HEAD/新增未跟踪文件）→ `PLANNING_SIDE_EFFECT_DETECTED`
  - SPEC 三态：未跟踪允许、工作区修改允许、staged 拒绝
  - 无变更 Task → 记录原因不创建空 Commit；中间 Checkpoint 追加与 `no_intermediate_changes`

## 验证门禁

```bash
npm run build && npm test && node scripts/check-architecture.mjs
```

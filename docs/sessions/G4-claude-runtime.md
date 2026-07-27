# G4：Claude Runtime 适配器 + Fake Claude 测试设施

## 会话目标

实现 ClaudeRuntimePort 及其适配器：参数数组调用、stream-json 事件契约、结构化结果提取、能力探测、错误集中映射；交付可编程 Fake Claude 与全部 stream/help 固件测试。

## 建议的 goal 完成判据

```text
完成 docs/sessions/G4-claude-runtime.md 定义的 G4 交付。
判据：
1. `npm test` 全绿，包含全部 stream 固件用例、help 固件用例、Fake Claude 集成用例。
2. G1–G3 测试保持全绿；架构扫描保持通过。
3. 适配器 API 与日志中不出现 PID、--resume、自动重启逻辑；错误映射全部集中在 adapters/claude。
```

## 前置条件

G1（Schema 校验、错误码）、G2（RedactionPort、FileSystemPort 接口）已通过。不依赖 G3。

## 起手读取

- 本文件、`TRACE.md` 第 4/8 节
- SPEC §7.1–7.2（Planning 与调用契约）、§8.1 第 4–5 项（能力探测）、§9.3（权限与禁用参数）、§9.6（失败语义）、§10 全章（鉴权与 Provider）、§11.4（Session Record 的 claude 字段）、§18.4（脱敏衔接）

## 交付物

- `src/application/ports/ClaudeRuntimePort.ts`：`invoke(request)`（request 含会话类型、提示词、JSON Schema、Session ID、权限模式、工作目录）+ `abort()`（仅杀直接子进程，供中断使用）
- `src/adapters/claude/`：
  - `client.ts`：spawn 参数数组、stdout/stderr 采集、退出码
  - `stream-parser.ts`：stream-json 逐行事件解析与终止事件判定
  - `capability.ts`：`--version` / `--help` 探测与必需能力判定
  - `errors.ts`：外部失败 → 稳定 errorCode 的**唯一**映射点
- `tests/fake-claude/`：可编程假 claude（Node 脚本，按场景文件输出 stream-json、记录 argv/env 到文件供断言）
- `tests/fixtures/claude-streams/`（成功/各类失败事件流）、`tests/fixtures/claude-help/`（多版本 help 输出）

## 规范性要点

### 调用契约（§7.2）

- 参数形态：`-p --session-id <UUID> --permission-mode <mode> --output-format stream-json --verbose --json-schema <Schema JSON 字符串> <提示词>`，全部经 spawn 参数数组传递，禁止 shell 字符串拼接。
- stream-json 契约（逐字按 §7.2 九条）：UTF-8 逐行 JSON、空行忽略；非空行非 JSON → `CLAUDE_STREAM_FAILED`；恰好一个 `type=="result"` 终止事件且 `structured_output` 通过对应 Schema；事件 Session ID 若存在必须与传入完全一致；多/缺终止事件、Session ID 冲突、退出 0 缺合法结果 → `CLAUDE_RESULT_INVALID`；未知合法非终止事件只脱敏写日志；stderr 只作脱敏诊断；成功 ⇔ 退出码 0 ∧ 终止事件合法。
- 按会话类型配置非法结果错误码：Planning/Execution → `CLAUDE_RESULT_INVALID`；Final Review → `FINAL_REVIEW_RESULT_INVALID`。
- `decision == "failed"` **不是**适配器错误：适配器返回成功事实，由 Application（G5）映射 `CLAUDE_REPORTED_FAILURE`。
- 其他错误：启动失败 → `CLAUDE_START_FAILED`（exitCode 记 null）；非零退出 → `CLAUDE_EXIT_NONZERO`；管道不可恢复错误 → `CLAUDE_STREAM_FAILED`。Provider/鉴权/网络/额度错误统一 `CLAUDE_EXIT_NONZERO` 并保留可读诊断（§10.3、§15.3）。

### 元数据与日志（§11.4、§18.4）

- `claude.version` 来自探测；`model`/`provider` 只从 stream 事件稳定字段提取，provider 走**允许列表**（不保存环境变量、端点查询参数、Header、完整配置）。
- 原始 stdout 事件经 RedactionPort 写 `logs/<session-id>.log`（FileSystemPort 注入）；stderr 脱敏后仅存诊断。
- 不读取/缓存/输出 API Key 与 Token；不调用 CC Switch 私有 API；不创建隔离配置目录（§10.2）。

### 能力探测（§8.1）

- `claude --version` 与 `claude --help`（参数数组）确认：Print Mode、`stream-json`、`--json-schema`、`plan`、`auto`、`bypassPermissions`、显式 Session ID。
- 帮助输出缺失/含糊/无法解析 = 能力缺失；输出缺失能力清单与实际版本并停止：`CLAUDE_CAPABILITY_MISSING` / `CLAUDE_INSTALLATION_UNHEALTHY`；不走兼容或降级路径。

### 边界

- 不保存 PID、不 `--resume`、不重启失败进程、不追踪进程树。`abort()` 只对直接 ChildProcess 调 `kill()`。
- 权限模式由调用方传入；适配器只校验枚举 {plan, auto, bypassPermissions}，不决定策略。

## 明确不做

- 提示词组装（G5）、Session Record 写入流程（G5 用 G2 落盘）、中断信号绑定（G6）。

## 测试清单

- stream 固件（golden file 驱动）：成功（三种会话类型）、非 JSON 非空行、两个 result 事件、缺失 result、Session ID 不匹配、退出 0 无合法结果、structured_output 不过 Schema、未知事件类型（只入日志）、空行混入、启动失败（不存在可执行文件）
- 错误映射表：每种外部失败 → 唯一 errorCode；其他模块不解析原始事件（架构扫描断言）
- capability 固件：完整 help、缺 `--json-schema`、缺权限枚举值、无法解析输出 → 对应判定；列出缺失能力
- Fake Claude 集成：argv 断言（数组形态、无 shell 拼接痕迹）；环境继承（自定义环境变量可见；敏感变量不出现在日志与 Record）；三种会话类型 × {成功、Schema 错误、非零退出}；`abort()` 对长睡眠进程在限时内返回
- CC Switch 风格：仅环境变量注入即可工作，无任何私有 API 调用

## 验证门禁

```bash
npm run build && npm test && node scripts/check-architecture.mjs
```

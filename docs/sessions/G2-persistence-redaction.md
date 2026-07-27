# G2：状态持久化 + 统一脱敏

## 会话目标

实现 StateStorePort、FileSystemPort、ClockPort、RedactionPort 四个端口及其适配器：临时文件替换写入、`stateRevision`/一致性读取协议、Plan Revision 提交顺序、统一脱敏边界与集中凭据语料。

## 建议的 goal 完成判据

```text
完成 docs/sessions/G2-persistence-redaction.md 定义的 G2 交付。
判据：
1. `npm test` 全绿，包含本文档"测试清单"全部用例（含 I/O 故障注入与跨分块凭据语料）。
2. G1 测试保持全绿；架构扫描保持通过。
3. 未触碰 Git、Claude、用例与 CLI 代码。
```

## 前置条件

G1 门禁已通过（Schema、Domain 校验、错误码可直接复用）。

## 起手读取

- 本文件、`TRACE.md` 第 1/4/7 节
- SPEC §4.1–4.2（布局与事实源）、§11.1–11.2（持久化目标与 JSON 写入）、§18.4（脱敏边界）、§15.3（state_error、command_error 行）、NFR-006

## 交付物

端口（`src/application/ports/`，纯接口 + DTO，归 Application 层）：

- `FileSystemPort`：read/write/rename/mkdir/readdir/stat/realpath/unlink/rm 等最小面（后续会话可追加方法，不改签名）
- `ClockPort`：`now(): Date`
- `StateStorePort`：run/tasks/planSnapshot/sessionRecord 的读写、一致性读取、stateRevision 语义
- `RedactionPort`：`redactText`、`redactStructured`、流式 `createChunkRedactor()`

适配器（`src/adapters/`）：

- `filesystem/`：node:fs/promises 实现
- `clock/`：系统时钟；RFC 3339 格式化复用 G1 纯函数
- `state/`：JSON State Store（写协议、校验、一致性读取、错误映射）
- `redaction/`：规则引擎 + 流式分块 redactor
- `tests/fixtures/redaction-corpus/`：集中版本化凭据语料

## 规范性要点

### JSON 写入（§11.2）

- 流程：serialize → 同目录临时文件 → close → rename → 重读并 Schema 校验。
- 正常返回的写入错误必须终止当前 Run → `STATE_WRITE_FAILED`；校验失败 → `STATE_VALIDATION_FAILED`。
- 每次成功替换 `run.json`，`stateRevision` 严格递增；写入前必须通过 G1 Domain 校验（State Store 只持久化过检聚合，§5.5）。
- `tasksSha256` = tasks.json 原始字节 SHA-256（用 `node:crypto`，适配器层允许）；`planRevision == 0` 时保持 null 且 tasks.json 必须不存在。

### Plan Revision 提交顺序（§11.2）

写并校验 Snapshot → 替换并校验 tasks.json → 计算 tasksSha256 → 最后替换 run.json。
任一步正常返回错误 → Run failed；不承诺跨文件事务、不维护 previous 文件。

### 一致性读取（§11.2）

1. 读并校验 run.json；2. 读并校验 tasks.json；3. 再读并校验 run.json；
4. 两次 `stateRevision` 相同；5. `planRevision` 相等；6. `tasksSha256` 匹配；
7. 不一致最多立即重试 3 次 → `STATE_SNAPSHOT_BUSY`（只读命令失败，不改 Run）。
`planRevision == 0` 特例：只做两次 run.json 的 stateRevision 比较。

### 脱敏（§18.4 + NFR-006）

- 统一边界：logs/、Session Record、run.json/tasks.json、Plan Snapshot、report.md、Archive Manifest 可读诊断、控制台 stdout/stderr —— 所有外部字符串进 Sink 前过同一个 RedactionPort。
- 规则：Authorization / Proxy-Authorization / Cookie / Set-Cookie Header 值；常见 API Key、Token、Bearer、Basic、私钥块、带凭据 URL；字段名匹配 `token|secret|password|apiKey|authorization`（不区分大小写）的值。
- 流式：分块边界保留足够重叠窗口，防止 token 跨块绕过；固定占位符；不得哈希/编码/部分回显原值；保持结构化 JSON 的类型与 Schema 合法性（值替换不破坏类型）。
- Provider 名称等元数据：**先允许列表提取，不先保存完整环境再脱敏**。
- 语料集中 `tests/fixtures/redaction-corpus/`；新增规则必须同步补回归样例。

## 明确不做

- Git、Claude、归档流程、报告生成、任何用例编排。
- 不实现跨文件事务、previous 文件、journal。

## 测试清单

- 临时文件替换：正常成功路径；普通 I/O 失败（Fake FileSystemPort 注入写入/rename/重读失败）→ 正确 errorCode
- stateRevision 严格递增断言；planRevision==0 特例（tasks.json 不存在时读取合法）
- 双读不一致、tasksSha256 不匹配、planRevision 不匹配 → 重试上限 → `STATE_SNAPSHOT_BUSY` 且不修改任何文件
- Plan 提交顺序： mock 记录调用次序断言四步顺序；中途失败不产出"半个新 Revision"的可观察状态
- 脱敏：语料中每个样本 × {日志行、Session Record JSON、run.json 片段、报告 Markdown、控制台行} × {整块写入、随机 chunk 边界流式写入}，输出不含任何机密；脱敏后 JSON 仍通过对应 Schema 校验

## 验证门禁

```bash
npm run build && npm test && node scripts/check-architecture.mjs
```

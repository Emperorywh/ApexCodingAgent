# ApexCodingAgent 分会话开发计划

> 适用规格：`docs/SPEC.md` v4.1.1（2621 行）。
>
> 存在理由：该规格的体量与验收范围超出单个 goal 会话的上下文安全线（评估结论见会话记录）。
> 本文档把实现拆为 6 个顺序开发会话 + 1 个发布/CI 阶段，每个会话有独立交付物与可执行验证门禁。

## 会话总览

| 会话 | 文档 | 交付 | 验证门禁 |
|---|---|---|---|
| G1 | [G1-domain-contracts.md](G1-domain-contracts.md) | 工程骨架 + 15 个内置 Schema + Domain 层（状态机、Plan 合并、Episode、不变量） | `npm run build && npm test` 绿；架构扫描绿 |
| G2 | [G2-persistence-redaction.md](G2-persistence-redaction.md) | StateStore/FileSystem/Clock/Redaction 端口与适配器、一致性读取、脱敏语料 | 全量测试绿（含故障注入与凭据语料） |
| G3 | [G3-git-spec-discovery.md](G3-git-spec-discovery.md) | GitPort 与 Git 适配器、SPEC 发现、Git 不变量、Checkpoint | 临时 Git 仓库集成测试绿 |
| G4 | [G4-claude-runtime.md](G4-claude-runtime.md) | ClaudeRuntimePort 与适配器、stream-json 契约、能力探测、Fake Claude 测试设施 | stream/help 固件测试 + Fake Claude 集成测试绿 |
| G5 | [G5-use-cases.md](G5-use-cases.md) | 7 个 Application 用例、内置 Prompt、Reporter、Run 驱动器、归档 | Fake Claude + 临时仓库端到端测试绿 |
| G6 | [G6-cli-bootstrap.md](G6-cli-bootstrap.md) | CLI 四命令、Composition Root、中断信号、退出码、发布骨架 | CLI 进程级测试绿；全量回归绿 |
| G7 | [G7-release-ci.md](G7-release-ci.md) | 发布矩阵与性能验收（**非开发会话**，CI/清单） | 按 G7 清单执行 |

## 依赖与顺序

```text
G1 ──┬── G2 ──┐
     ├── G3 ──┼── G5 ── G6
     └── G4 ──┘
```

- G1 必须先完成。
- G2、G3、G4 互不依赖，可任意顺序（甚至并行）进行。
- G5 依赖 G1–G4；G6 依赖 G5。
- 前一门禁未绿，不得开始下一会话。每个会话结束时跑**全量**测试（不是只跑本会话新增），保证不破坏前序交付。

## 每个会话的起手协议

1. 阅读：本文件对应行 → [TRACE.md](TRACE.md) → 对应 G 文档 → G 文档中列出的 SPEC 章节。
2. **不要**全文重读 SPEC.md；G 文档已抽取该会话需要的规范性细节。
3. 冲突裁决顺序：`SPEC.md` > G 文档 > `TRACE.md`。发现矛盾时停止并报告，不要自行发挥。
4. 不要"顺手"实现后续会话的模块；不要重构前序会话已交付且测试覆盖的代码。
5. 每个 G 文档末尾有"建议的 goal 完成判据"，可直接用于 goal 模式的 objective。

## 全局技术决策（各会话不得重新决策）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 语言/模块 | TypeScript `strict`，ESM（`module: NodeNext`，target ≥ ES2022） | SPEC §5.1 |
| engines | `>=22 <23 \|\| >=24 <25` | SPEC §5.1 原文 |
| 包管理/构建 | npm + `tsc` 输出 `dist/` | 发布物为 Node.js 包（§5.1） |
| 测试框架 | vitest（单元与集成统一） | Node 22/24 + ESM 成熟支持；fake timer 便于 Clock 测试 |
| JSON Schema | ajv（纯 JS，可入 Domain 层），自定义 format：`uuid`、`sha256`、`git-oid`、`rfc3339` | §11.5 要求内置集中版本化；Domain 不得依赖 Node API（§5.3） |
| CLI 参数解析 | `node:util` 的 `parseArgs` | 零额外依赖，满足 §17 四个命令 |
| 随机性 | `globalThis.crypto.randomUUID()`（Web 标准全局，**不** import `node:crypto` 进 Domain/Application） | §5.3 约束下唯一无导入来源；ID 生成在 Application 层 |
| 子进程 | `child_process.spawn` 参数数组；禁止 shell 字符串拼接 | SPEC §7.2 原文 |
| 时间 | ClockPort 注入；输出用 Domain 纯函数格式化为 UTC RFC 3339 | §11.5；NFR-005 可测试性 |
| 架构守护 | `scripts/check-architecture.mjs` 扫描 import 方向，纳入 `npm test` | §5.3、NFR-002 |

## 源码布局（G1 建立，后续会话只增不改）

```text
src/
  domain/            # G1：实体、状态机、Plan 合并、不变量、错误码、schemas/
  application/
    ports/           # G2–G5 陆续补充（归 Application 层所有，§5.3）
    usecases/        # G5
    prompts/         # G5（§24–26 模板）
  adapters/
    filesystem/ clock/ state/ redaction/   # G2
    git/                                   # G3
    claude/                                # G4
    reporter/                              # G5
  interfaces/cli/    # G6
  bootstrap/         # G6
tests/
  unit/ integration/ e2e/
  fixtures/          # stream-json、help 输出、凭据语料、任务计划固件
  fake-claude/       # G4 交付的可编程假 claude 可执行脚本
scripts/
  check-architecture.mjs   # G1
  scan-forbidden.mjs       # G6（AC-025）
```

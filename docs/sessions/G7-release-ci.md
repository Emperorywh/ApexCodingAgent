# G7：发布矩阵与性能验收（CI 阶段，非开发会话）

> 本文件**不是** goal 开发会话。SPEC 的 DoD 中有三类条目在结构上无法在任何单个开发会话内完成：
> 多平台/多 Node 版本矩阵、真实 Claude Code + CC Switch 环境验收、NFR-007 性能协议。
> 它们属于 CI/发布阶段。本清单把这些条目收集到一处，防止被遗忘或被谎报为已完成。

## 前置条件

G1–G6 门禁全部通过，代码已合并到待发布分支。

## A. 发布运行矩阵（AC-024、NFR-008）

- [ ] Node.js 22.x 最新补丁版本：完整自动化测试通过
- [ ] Node.js 24.x 最新补丁版本：完整自动化测试通过
- [ ] 其他 Node 主版本启动 → `ENVIRONMENT_UNSUPPORTED`（退出码 3），无隐式兼容
- [ ] Windows 10 x64 与 Windows 11 x64 上分别执行完整测试（§22.3：真实验收必须在 Win10/11 完成）
- [ ] 发布物依赖扫描：无 .NET/C#/Rust/C++/N-API/`.node` 原生模块（复用 `scripts/scan-forbidden.mjs`）
- [ ] `npm pack` 产物检查：只含 dist 与必要资产，bin `ApexCodingAgent` 可执行

> 注意：GitHub hosted runner 的 `windows-latest` 是 **Windows Server**，不等于 Windows 10/11 桌面版。
> 满足 §22.3 需要自托管 Win10/Win11 Runner，或明确记录偏差并由项目所有者决策——不要在报告里把 Server 写成桌面版。

## B. NFR-007 性能验收协议（逐字按 SPEC）

- [ ] 平台：Windows 10 与 Windows 11 x64 发布 Runner（≥4 逻辑 CPU、8 GB 内存、SSD）
- [ ] Node.js 22.x 与 24.x 分别生成结果（共 2×2 = 4 组）
- [ ] 固定 Fixture：50 个 pending Task、200 个历史 Execution Episode、10 个 Plan Revision
- [ ] 每项先预热 20 次，再连续测量 200 次；P95 用 nearest-rank 计算
- [ ] 指标门槛：本地 Task 选择 P95 < 100ms；本地状态读取 P95 < 500ms；`status` P95 < 2s；不含 Claude/Git 的启动检查 P95 < 2s
- [ ] Claude 调用不得进入本地性能样本；只有明确标注"不含 Git"的指标可换 Fake Git Port
- [ ] 报告原始样本、Node.js 版本、Windows Build、硬件摘要
- [ ] 任一平台×Node 组合不达标即 NFR-007 未通过

## C. 真实环境端到端冒烟（AC-001、AC-005、AC-006）

- [ ] 装有真实 Claude Code + 已配置 Provider（或 CC Switch）的 Windows 机器
- [ ] 只有 `SPEC.md` 的最小 Git 项目：`ApexCodingAgent start` 进入 planning 并完成至少一个 Task
- [ ] Claude 子进程直接使用当前 Provider，无需 Apex 做任何凭据处理
- [ ] Execution Session 中 Skills/MCP/Subagents/Plugins/Hooks 按用户配置可用
- [ ] `status`、`report`、`abandon --force` 各执行一次，行为与 §17 一致

## D. DoD 终检（SPEC §23）

- [ ] 逐条对照 §23 清单签字；每条能指认到自动化证据（G1–G6 测试）或本文件 A/B/C 项
- [ ] §22.4 需求追踪矩阵：28 个 FR 全部有 AC + 自动化证据覆盖
- [ ] report.md 示例输出人工审查：不包含凭据、不声称无证据的独立验证

## 完成定义

A–D 全部勾选后，系统达到 SPEC §23 的 MVP Ready。任何一项无法执行（例如缺自托管 Runner），
必须显式记录为未通过项，不得静默省略。

# SPEC 到 Goal 追踪矩阵

本矩阵负责章节级归属。GOAL-00 创建的逐条需求账本负责具体规范性语句的完整追踪。

## 章节归属

| SPEC 章节 | 主 Goal | 协同 Goal | 说明 |
|---|---|---|---|
| §1～§3 | GOAL-00 | 全部 | 权威层级、术语和全局目标 |
| §4.1～§4.3 | GOAL-01 | 全部 | 分层、模块边界、单一职责 |
| §4.4 | GOAL-02 | GOAL-05、GOAL-12 | 单一状态提交点与运行目录 |
| §5.1 | GOAL-00 | GOAL-04～GOAL-12 | 信任模型 |
| §5.2～§5.3 | GOAL-04 | GOAL-06、GOAL-12、GOAL-13 | 沙箱、权限、命令授权 |
| §5.4 | GOAL-05 | GOAL-04、GOAL-06、GOAL-12 | 脱敏、审计、Session/命令事实 |
| §6 | GOAL-03 | GOAL-10 | Plan、criterion、命令、追踪、scope、revision |
| §7 | GOAL-10 | GOAL-04、GOAL-03 | 独立 Plan Review |
| §8 | GOAL-03 | GOAL-07～GOAL-12 | Task/Run 状态机 |
| §9 | GOAL-07 | GOAL-02、GOAL-08、GOAL-09 | Execution 与 Candidate |
| §10.1～§10.3 | GOAL-05 | GOAL-02 | 类型化 Evidence Store |
| §10.4～§10.7 | GOAL-06 | GOAL-04、GOAL-05、GOAL-08 | Verification、视觉和人工证据 |
| §11 | GOAL-03 | GOAL-08、GOAL-09、GOAL-11 | Issue |
| §12 | GOAL-08 | GOAL-04～GOAL-07、GOAL-09 | 独立 Task Review |
| §13 | GOAL-09 | GOAL-03、GOAL-05、GOAL-08 | Review Invalidation |
| §14 | GOAL-11 | GOAL-06、GOAL-08～GOAL-10 | Final Review |
| §15.1～§15.4 | GOAL-02 | GOAL-05～GOAL-12 | 提交点、幂等和恢复 |
| §15.5 | GOAL-01 | GOAL-07、GOAL-08、GOAL-10、GOAL-11、GOAL-13 | Prompt stdin 与长 Prompt |
| §15.6 | GOAL-12 | GOAL-02、GOAL-04、GOAL-13 | heartbeat、单实例、中断 |
| §16 | GOAL-11 | GOAL-10、GOAL-12 | Context Bundle 与 Run Budget |
| §17 | GOAL-12 | GOAL-06、GOAL-10、GOAL-11 | CLI、进度和报告 |
| §18 | GOAL-12 | GOAL-02、GOAL-04、GOAL-06、GOAL-07 | Git、工作区和归档 |
| §19.1 | GOAL-10 | GOAL-03 | Planning Prompt |
| §19.2 | GOAL-10 | — | Plan Review Prompt |
| §19.3 | GOAL-07 | — | Execution Prompt |
| §19.4 | GOAL-08 | — | Task Review Prompt |
| §19.5 | GOAL-11 | — | Final Review Prompt |
| §20.1～§20.2 | GOAL-13 | 全部 | 自动化测试与测试质量 |
| §20.3 | GOAL-14 | GOAL-13 | 真实模型评估 |
| §21 | GOAL-14 | GOAL-00～GOAL-13 | AC 最终审计 |
| §22 | 本目录 | 全部 | 实施顺序 |
| §23 | GOAL-14 | GOAL-13 | 完成定义 |

## AC 归属

| AC | 主要实现 Goal | 最终验证 Goal |
|---|---|---|
| AC-001 独立计划复核 | GOAL-10 | GOAL-13、GOAL-14 |
| AC-002 Candidate 与完成分离 | GOAL-07、GOAL-08 | GOAL-13、GOAL-14 |
| AC-003 Review Subject 正确 | GOAL-08、GOAL-09 | GOAL-13、GOAL-14 |
| AC-004 Evidence Policy | GOAL-03、GOAL-05、GOAL-08 | GOAL-13、GOAL-14 |
| AC-005 真实命令事实 | GOAL-05、GOAL-06 | GOAL-13、GOAL-14 |
| AC-006 安全执行 | GOAL-04、GOAL-06 | GOAL-13、GOAL-14 |
| AC-007 Issue 阻断 | GOAL-03、GOAL-08、GOAL-11 | GOAL-13、GOAL-14 |
| AC-008 影响失效与重验 | GOAL-09 | GOAL-13、GOAL-14 |
| AC-009 Final Review 唯一门槛 | GOAL-11、GOAL-12 | GOAL-13、GOAL-14 |
| AC-010 幂等恢复 | GOAL-02 | GOAL-13、GOAL-14 |
| AC-011 人工决定闭环 | GOAL-06、GOAL-10、GOAL-12 | GOAL-13、GOAL-14 |
| AC-012 上下文与预算 | GOAL-11 | GOAL-13、GOAL-14 |
| AC-013 可审计报告 | GOAL-12 | GOAL-13、GOAL-14 |
| AC-014 架构守护 | GOAL-01 | 每个 Goal、GOAL-14 |
| AC-015 完整门禁 | GOAL-13、GOAL-14 | GOAL-14 |

## 横切要求

以下要求不属于单一 Goal，所有实现阶段都必须遵守：

- 不兼容旧状态和报告，不提供迁移或兼容读取。
- 不保留 fallback、deprecated、灰度或双重完成语义。
- 所有外部文本经过 RedactionPort。
- 相对导入携带 `.js` 扩展名。
- `readonly` 契约、纯领域函数和显式依赖注入。
- Domain/Application 不依赖 `node:*` 或外层。
- Windows-only，Node.js 22.x / 24.x。
- 不自动推送、部署、付款或修改生产数据。
- 不自动重试认证、网络、额度、模型或验证失败。
- 不引入 SPEC §2.3 和扫描脚本禁止的实现。


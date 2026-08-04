/**
 * 进度呈现模型的纯函数测试：Run 生命周期、Task Review 与 Session 切换
 * 均使用稳定的标题/事实里程碑块。
 */
import { describe, expect, it } from 'vitest';
import {
  renderPlanReviewChangesRequired,
  renderPlanReviewStarted,
  renderRunCreated,
  renderRunResumed,
  renderSessionStarted,
  renderTaskReviewChangesRequired,
  renderTaskReviewStarted,
  sessionDisplayName,
} from '../../src/application/presentation/progress.js';
import { OID_B, UUID_1 } from '../domain/fixtures.js';

describe('Run 生命周期呈现', () => {
  it('创建与恢复里程碑只展示已确认的 Run、分支和继续位置', () => {
    expect(
      renderRunCreated({
        runId: 'RUN-001',
        specPath: 'SPEC.md',
        runBranch: 'apex-coding-agent/RUN-001',
      }),
    ).toEqual([
      '',
      '◇ 运行已创建',
      '  Run RUN-001',
      '  SPEC SPEC.md · 分支 apex-coding-agent/RUN-001',
    ]);
    expect(
      renderRunResumed({ runId: 'RUN-001', stage: 'running', taskId: 'TASK-003' }),
    ).toEqual([
      '',
      '↻ 运行已恢复',
      '  Run RUN-001',
      '  继续阶段 任务执行 · TASK-003',
    ]);
  });
});

describe('Task Review 进度呈现', () => {
  it('renderTaskReviewStarted 输出 taskId、开始符号与候选 Checkpoint 前缀', () => {
    const block = renderTaskReviewStarted('TASK-001', OID_B);
    expect(block).toEqual([
      '',
      '◇ TASK-001 候选实现已保存',
      `  Checkpoint ${OID_B.slice(0, 12)} · 开始独立复核`,
    ]);
  });

  it('renderTaskReviewChangesRequired 输出 taskId 与返工符号', () => {
    expect(renderTaskReviewChangesRequired('TASK-001')).toEqual([
      '',
      '↻ TASK-001 独立复核未通过',
      '  正在进入修复执行',
    ]);
  });

  it('task_review 会话开始行渲染为「任务独立复核」', () => {
    expect(sessionDisplayName('task_review')).toBe('任务独立复核');
    const block = renderSessionStarted({
      sessionId: UUID_1,
      type: 'task_review',
      taskId: 'TASK-001',
      planRevision: 2,
    });
    expect(block).toEqual([
      '',
      '◆ 任务独立复核 · TASK-001',
      `  计划版本 2 · 会话 ${UUID_1.slice(0, 8)}`,
    ]);
  });
});

describe('Plan Review 进度呈现', () => {
  it('renderPlanReviewStarted 输出计划版本号与开始符号', () => {
    expect(renderPlanReviewStarted(2)).toEqual([
      '',
      '◇ 计划草稿已保存',
      '  计划版本 2 · 开始独立复核',
    ]);
  });

  it('renderPlanReviewChangesRequired 输出反馈轮次与返工符号', () => {
    expect(renderPlanReviewChangesRequired(1)).toEqual([
      '',
      '↻ 计划独立复核未通过',
      '  正在重新规划 · 第 1 轮反馈',
    ]);
  });

  it('plan_review 会话开始行渲染为「计划独立复核」', () => {
    expect(sessionDisplayName('plan_review')).toBe('计划独立复核');
    const block = renderSessionStarted({
      sessionId: UUID_1,
      type: 'plan_review',
      taskId: null,
      planRevision: 1,
    });
    expect(block).toEqual([
      '',
      '◆ 计划独立复核',
      `  计划版本 1 · 会话 ${UUID_1.slice(0, 8)}`,
    ]);
  });
});

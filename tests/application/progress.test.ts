/**
 * 进度呈现模型的纯函数测试：Task Review 阶段的单行摘要与 Session 类型
 * 中文标签（「任务独立复核」）稳定可见。
 */
import { describe, expect, it } from 'vitest';
import {
  renderPlanReviewChangesRequired,
  renderPlanReviewStarted,
  renderSessionStarted,
  renderTaskReviewChangesRequired,
  renderTaskReviewStarted,
  sessionDisplayName,
} from '../../src/application/presentation/progress.js';
import { OID_B, UUID_1 } from '../domain/fixtures.js';

describe('Task Review 进度呈现', () => {
  it('renderTaskReviewStarted 输出 taskId、开始符号与候选 Checkpoint 前缀', () => {
    const line = renderTaskReviewStarted('TASK-001', OID_B);
    expect(line).toBe(`◇ TASK-001 候选实现已保存 · 开始独立复核 · Checkpoint ${OID_B.slice(0, 12)}`);
    expect(line).toContain('TASK-001');
    expect(line).toContain('◇');
  });

  it('renderTaskReviewChangesRequired 输出 taskId 与返工符号', () => {
    const line = renderTaskReviewChangesRequired('TASK-001');
    expect(line).toBe('↻ TASK-001 独立复核未通过 · 正在进入修复执行');
    expect(line).toContain('TASK-001');
    expect(line).toContain('↻');
  });

  it('task_review 会话开始行渲染为「任务独立复核」', () => {
    expect(sessionDisplayName('task_review')).toBe('任务独立复核');
    const line = renderSessionStarted({
      sessionId: UUID_1,
      type: 'task_review',
      taskId: 'TASK-001',
      planRevision: 2,
    });
    expect(line).toBe(`◆ 任务独立复核 TASK-001 · 计划版本 2 · 会话 ${UUID_1.slice(0, 8)}`);
  });
});

describe('Plan Review 进度呈现', () => {
  it('renderPlanReviewStarted 输出计划版本号与开始符号', () => {
    const line = renderPlanReviewStarted(2);
    expect(line).toBe('◇ 计划草稿已生成 · 开始独立复核 · 计划版本 2');
    expect(line).toContain('计划版本 2');
    expect(line).toContain('◇');
  });

  it('renderPlanReviewChangesRequired 输出反馈轮次与返工符号', () => {
    const line = renderPlanReviewChangesRequired(1);
    expect(line).toBe('↻ 计划独立复核未通过 · 正在重新规划 · 第 1 轮反馈');
    expect(line).toContain('第 1 轮反馈');
    expect(line).toContain('↻');
  });

  it('plan_review 会话开始行渲染为「计划独立复核」', () => {
    expect(sessionDisplayName('plan_review')).toBe('计划独立复核');
    const line = renderSessionStarted({
      sessionId: UUID_1,
      type: 'plan_review',
      taskId: null,
      planRevision: 1,
    });
    expect(line).toContain('计划独立复核');
  });
});

/**
 * Plan Revision Trigger 安全事实测试。
 *
 * Trigger 的自由文本会同时进入日志、Planning Prompt 与不可变 Snapshot；
 * 这里验证用例入口只生成一份可复用的安全事实。
 */
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import { sanitizePlanRevisionTrigger } from '../../src/application/usecases/plan-revision-trigger.js';

const redaction = createRedactor();

describe('sanitizePlanRevisionTrigger', () => {
  it('redacts the reason without changing identity facts', () => {
    const secret = 'sk-proj-abcdefghijklmnop';
    const trigger = {
      type: 'execution_replan' as const,
      reason: `Execution requested replan with ${secret}`,
      sourceSessionId: '123e4567-e89b-42d3-a456-426614174000',
    };

    const result = sanitizePlanRevisionTrigger(trigger, redaction);

    expect(result).toEqual({
      ...trigger,
      reason: 'Execution requested replan with [REDACTED]',
    });
    expect(result).not.toBe(trigger);
    expect(trigger.reason).toContain(secret);
  });

  it('uses a stable non-secret reason when normalization removes all input', () => {
    /*
     * Schema 要求 reason 非空；纯控制序列不能回退到原文，也不能让后续
     * Snapshot 写入因空字符串失败。
     */
    const result = sanitizePlanRevisionTrigger(
      {
        type: 'run_resumed',
        reason: '\u001b[31m\u001b[0m',
        sourceSessionId: null,
      },
      redaction,
    );

    expect(result.reason).toBe('trigger reason removed by redaction');
  });
});

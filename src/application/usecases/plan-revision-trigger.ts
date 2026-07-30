/**
 * Plan Revision Trigger 的安全事实组装边界（SPEC §18.4）。
 *
 * Trigger 可能来自 Execution 或 Final Review 的 Claude 结构化结果，也可能
 * 来自程序生成的恢复事件。无论来源如何，进入提示词、日志和不可变 Snapshot
 * 前都统一清洗 reason，避免各状态分支复制并遗漏同一条安全规则。
 */
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RedactionPort } from '../ports/redaction.js';

/**
 * 返回全新的安全 Trigger；类型、Session ID 是受 Schema 约束的标识事实，
 * 只有自由文本 reason 需要执行凭据检测与控制序列规范化。
 */
export function sanitizePlanRevisionTrigger(
  trigger: PlanRevisionTrigger,
  redaction: RedactionPort,
): PlanRevisionTrigger {
  const reason = redaction.redactText(trigger.reason);
  return {
    ...trigger,
    /*
     * 纯控制序列会在规范化后变为空；Trigger Schema 要求非空，因此使用不含
     * 外部内容的稳定说明，绝不回退到原始 reason。
     */
    reason: reason.length > 0 ? reason : 'trigger reason removed by redaction',
  };
}

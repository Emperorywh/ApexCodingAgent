/**
 * 已提交 Plan Revision 历史的完整读取原语。
 *
 * 报告与 Final Review 都要求 Revision 1..run.planRevision 连续存在；静默
 * 跳过缺失 Snapshot 会把损坏状态伪装成完整交付。该原语集中执行完整性
 * 校验，调用方只消费按 Revision 升序排列的不可变事实。
 */
import { ApexError } from '../../domain/errors.js';
import type { PlanRevisionSnapshot } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { StateStorePort } from '../ports/state-store.js';

/** 读取当前 Run 的完整 Revision 历史；任一 Snapshot 缺失或串 Run即失败。 */
export async function readCompletePlanRevisionHistory(
  stateStore: StateStorePort,
  run: RunJson,
): Promise<PlanRevisionSnapshot[]> {
  const history: PlanRevisionSnapshot[] = [];
  for (let revision = 1; revision <= run.planRevision; revision += 1) {
    const snapshot = await stateStore.readPlanSnapshot(revision);
    if (snapshot === null) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'state',
        message: `plan revision snapshot ${revision} is missing for run ${run.runId}`,
      });
    }
    if (snapshot.runId !== run.runId) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'state',
        message:
          `plan revision snapshot ${revision} belongs to ${snapshot.runId}, ` +
          `expected ${run.runId}`,
      });
    }
    history.push(snapshot);
  }
  return history;
}

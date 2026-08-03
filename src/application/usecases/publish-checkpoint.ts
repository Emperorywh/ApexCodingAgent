/**
 * Checkpoint 远程发布的 Application 协调器。
 *
 * 本模块把 Run 快照转换为 GitPort 的完整发布输入，并统一记录成功事实；
 * 各业务用例仍负责决定发布失败后如何关闭自己的 Episode 与状态机。
 */
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { CheckpointOutcome } from '../ports/GitPort.js';
import type { UseCaseDeps } from '../usecase-deps.js';

/**
 * task-candidate：Execution 候选 Checkpoint（批准前先发布留痕）；
 * 其余为中间/最终复核 Checkpoint。Task 的最终 Checkpoint 复用候选发布，
 * 不再有独立 task-final 种类。
 */
export type CheckpointKind =
  | 'task-candidate'
  | 'task-intermediate'
  | 'final-review-final'
  | 'final-review-intermediate';

export async function publishCheckpoint(
  deps: Pick<UseCaseDeps, 'git' | 'logger'>,
  run: RunJson,
  checkpoint: CheckpointOutcome,
  kind: CheckpointKind,
): Promise<void> {
  await deps.git.publishRunBranch(run.repository.root, {
    remote: run.runSettings.pushRemote,
    runBranch: run.repository.runBranch,
    checkpointOid: checkpoint.finalOid,
  });
  deps.logger.log('debug', 'git.checkpoint_published', {
    kind,
    remote: run.runSettings.pushRemote,
    runBranch: run.repository.runBranch,
    checkpoint: checkpoint.finalOid,
  });
}

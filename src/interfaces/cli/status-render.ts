/**
 * `status` 命令渲染（SPEC §17）：把通过一致性读取协议（§11.2）取得的
 * 快照与只读 Git 事实渲染为人类可读行。只展示已提交事实，不展示内存
 * 状态；行内容在输出前统一经 RedactionPort（§18.4 控制台 Sink）。
 */
import type { RepositoryStatusFact } from '../../application/ports/GitPort.js';
import type { ConsistentSnapshot } from '../../application/ports/state-store.js';
import type { RunJson } from '../../domain/schemas/run-json.js';

function shortOid(oid: string | null): string {
  return oid === null ? '-' : oid.slice(0, 12);
}

function taskLine(run: RunJson, taskId: string, title: string | null): string {
  const state = run.tasks[taskId];
  const status = state?.status ?? 'pending';
  const parts = [`  ${taskId}`, status.padEnd(9)];
  if (state?.finalCheckpoint != null) parts.push(`checkpoint ${shortOid(state.finalCheckpoint)}`);
  if (state?.skipReason != null) parts.push(`skipped: ${state.skipReason}`);
  if (state?.failure != null) parts.push(`failed: ${state.failure.errorCode}`);
  if (title !== null) parts.push(title);
  return parts.join('  ');
}

export function renderStatus(
  snapshot: ConsistentSnapshot,
  git: RepositoryStatusFact,
): string[] {
  const { run, tasks } = snapshot;
  const lines: string[] = [];

  lines.push(`Run: ${run.runId}`);
  lines.push(`Status: ${run.status}`);
  lines.push(`SPEC: ${run.spec.path} (sha256 ${run.spec.sha256.slice(0, 12)}…)`);
  lines.push(`Plan revision: ${run.planRevision}`);
  lines.push(`Created: ${run.createdAt}`);
  lines.push(`Updated: ${run.updatedAt}`);
  lines.push(`Terminal: ${run.terminalAt ?? '-'}`);
  lines.push(
    `Base branch: ${run.repository.baseBranch} (${run.repository.baseBranchRef}) @ ${shortOid(run.repository.baseCommit)}`,
  );
  lines.push(`Run branch: ${run.repository.runBranch}`);
  lines.push(
    `Git HEAD: ${shortOid(git.head.oid)} (branch: ${git.head.branch ?? 'detached'})`,
  );
  lines.push(`Current task: ${run.currentTaskId ?? '-'}`);
  lines.push(
    run.activeSession === null
      ? 'Active session: -'
      : `Active session: ${run.activeSession.sessionId} (${run.activeSession.type}` +
          `${run.activeSession.taskId === null ? '' : `, ${run.activeSession.taskId}`})`,
  );

  /**
   * 当前计划 Task 保持 tasks.json 的稳定顺序；被后续 Revision 移出的
   * 历史 Task 仍以 skipped 永久保存在 run.json，按 ID 稳定追加展示。
   * 这样总数、状态计数和实际渲染行始终属于同一组任务事实。
   */
  const currentIds = tasks !== null ? tasks.tasks.map((task) => task.id) : [];
  const currentIdSet = new Set(currentIds);
  const historicalIds = Object.keys(run.tasks)
    .filter((taskId) => !currentIdSet.has(taskId))
    .sort();
  const orderedIds = tasks === null ? historicalIds : [...currentIds, ...historicalIds];
  const counts = new Map<string, number>();
  for (const state of Object.values(run.tasks)) {
    counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(', ');
  lines.push(`Tasks: ${orderedIds.length} total${summary === '' ? '' : ` (${summary})`}`);
  const titles = new Map((tasks?.tasks ?? []).map((task) => [task.id, task.title]));
  for (const taskId of orderedIds) {
    lines.push(taskLine(run, taskId, titles.get(taskId) ?? null));
  }

  lines.push(
    run.lastError === null
      ? 'Last error: -'
      : `Last error: ${run.lastError.errorCode} (${run.lastError.stage}): ${run.lastError.message}`,
  );
  lines.push(`Report: ${run.reportPath ?? '-'}`);
  return lines;
}

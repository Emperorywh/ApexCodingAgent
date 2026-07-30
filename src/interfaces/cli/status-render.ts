/**
 * `status` 命令渲染（SPEC §17）：把通过一致性读取协议（§11.2）取得的
 * 快照与只读 Git 事实渲染为人类可读行。只展示已提交事实，不展示内存
 * 状态；行内容在输出前统一经 RedactionPort（§18.4 控制台 Sink）。
 */
import type { RepositoryStatusFact } from '../../application/ports/GitPort.js';
import type { ConsistentSnapshot } from '../../application/ports/state-store.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import type { RunJson, RunStatus } from '../../domain/schemas/run-json.js';
import type {
  TaskRuntimeState,
  TaskStatus,
} from '../../domain/schemas/task-runtime-state.js';

interface StatusPresentation {
  readonly icon: string;
  readonly label: string;
}

/**
 * 状态展示词汇集中维护，避免概览、计数和任务行各自解释同一领域状态。
 *
 * 图标同时是终端颜色层的语义标记；纯文本和重定向输出仍保留完整含义。
 */
const RUN_STATUS_PRESENTATION: Readonly<Record<RunStatus, StatusPresentation>> = {
  planning: { icon: '◆', label: '规划中' },
  running: { icon: '→', label: '执行中' },
  final_review: { icon: '◆', label: '最终检查' },
  completed: { icon: '✓', label: '已完成' },
  failed: { icon: '✗', label: '运行失败' },
  abandoned: { icon: '⊘', label: '已放弃' },
};

const TASK_STATUS_PRESENTATION: Readonly<Record<TaskStatus, StatusPresentation>> = {
  pending: { icon: '◇', label: '待处理' },
  running: { icon: '→', label: '执行中' },
  completed: { icon: '✓', label: '已完成' },
  failed: { icon: '✗', label: '失败' },
  skipped: { icon: '⊘', label: '已跳过' },
};

/**
 * 计数始终按用户最关心的顺序展示，不依赖对象属性或状态迁移的插入顺序。
 *
 * “已完成”置前，“待处理/已跳过”置后，使正常路径和异常路径都容易扫读。
 */
const TASK_STATUS_SUMMARY_ORDER: readonly TaskStatus[] = [
  'completed',
  'running',
  'failed',
  'pending',
  'skipped',
];

const PROGRESS_BAR_WIDTH = 24;

function shortOid(oid: string | null): string {
  return oid === null ? '—' : oid.slice(0, 12);
}

/**
 * 当前计划保持 tasks.json 的稳定顺序；被后续 Revision 移出的历史任务
 * 仍以 skipped 永久保存在 run.json，并按 ID 稳定追加在当前计划之后。
 */
function orderedTaskIds(snapshot: ConsistentSnapshot): readonly string[] {
  const { run, tasks } = snapshot;
  const currentIds = tasks?.tasks.map((task) => task.id) ?? [];
  const currentIdSet = new Set(currentIds);
  const historicalIds = Object.keys(run.tasks)
    .filter((taskId) => !currentIdSet.has(taskId))
    .sort();
  return tasks === null ? historicalIds : [...currentIds, ...historicalIds];
}

function taskStatus(run: RunJson, taskId: string): TaskStatus {
  return run.tasks[taskId]?.status ?? 'pending';
}

/**
 * 计数基于最终会渲染的任务集合，而不是单独遍历 run.tasks。
 *
 * 这使缺少运行态记录但已进入计划的任务仍明确计入“待处理”，避免总数与
 * 状态小计在边界快照中出现视觉不一致。
 */
function countTaskStatuses(
  run: RunJson,
  taskIds: readonly string[],
): Readonly<Record<TaskStatus, number>> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const taskId of taskIds) {
    counts[taskStatus(run, taskId)] += 1;
  }
  return counts;
}

function renderProgressBar(completed: number, total: number): string {
  const ratio = total === 0 ? 0 : completed / total;
  const filledWidth = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const bar = `${'█'.repeat(filledWidth)}${'░'.repeat(PROGRESS_BAR_WIDTH - filledWidth)}`;
  return `  ${bar}  ${completed}/${total} · ${Math.round(ratio * 100)}%`;
}

function renderStatusSummary(counts: Readonly<Record<TaskStatus, number>>): string {
  const visibleCounts = TASK_STATUS_SUMMARY_ORDER
    .filter((status) => counts[status] > 0)
    .map((status) => `${TASK_STATUS_PRESENTATION[status].label} ${counts[status]}`);
  return visibleCounts.length === 0 ? '  暂无任务' : `  ${visibleCounts.join(' · ')}`;
}

function taskDetail(state: TaskRuntimeState | undefined): string | null {
  if (state?.finalCheckpoint != null) {
    return `检查点 ${shortOid(state.finalCheckpoint)}`;
  }
  if (state?.failure != null) {
    return state.failure.errorCode;
  }
  if (state?.skipReason != null) {
    return state.skipReason;
  }
  return null;
}

function renderTaskLine(run: RunJson, taskId: string, title: string | null): string {
  const state = run.tasks[taskId];
  const presentation = TASK_STATUS_PRESENTATION[state?.status ?? 'pending'];
  const detail = taskDetail(state);
  const titlePart = title === null ? '' : `  ${title}`;
  const detailPart = detail === null ? '' : ` · ${detail}`;
  return `  ${presentation.icon} ${taskId}${titlePart}${detailPart}`;
}

function sessionTypeLabel(type: SessionType): string {
  switch (type) {
    case 'planning':
      return '规划';
    case 'execution':
      return '执行';
    case 'final_review':
      return '最终检查';
  }
}

function renderOverview(run: RunJson): string[] {
  const presentation = RUN_STATUS_PRESENTATION[run.status];
  const lines = [
    'ApexCodingAgent · 运行状态',
    '',
    `${presentation.icon} ${presentation.label} · ${run.runId}`,
    `  SPEC      ${run.spec.path} · sha256 ${run.spec.sha256.slice(0, 12)}…`,
    `  计划修订  ${run.planRevision}`,
    `  创建时间  ${run.createdAt}`,
    `  更新时间  ${run.updatedAt}`,
  ];

  if (run.terminalAt !== null) {
    lines.push(`  结束时间  ${run.terminalAt}`);
  }
  if (run.currentTaskId !== null) {
    lines.push(`  当前任务  ${run.currentTaskId}`);
  }
  if (run.activeSession !== null) {
    const task = run.activeSession.taskId === null ? '' : ` · ${run.activeSession.taskId}`;
    lines.push(
      `  活跃会话  ${sessionTypeLabel(run.activeSession.type)} · ` +
        `${run.activeSession.sessionId}${task}`,
    );
  }
  return lines;
}

function renderLastError(run: RunJson): string[] {
  if (run.lastError === null) return [];

  const lines = [
    '',
    `! 最近错误 · ${run.lastError.errorCode} · ${run.lastError.stage}`,
    `  ${run.lastError.message}`,
  ];
  if (run.resumePoint !== null) {
    lines.push('  → 恢复运行  ApexCodingAgent resume');
  }
  return lines;
}

function renderTasks(snapshot: ConsistentSnapshot): string[] {
  const taskIds = orderedTaskIds(snapshot);
  const counts = countTaskStatuses(snapshot.run, taskIds);
  const titles = new Map((snapshot.tasks?.tasks ?? []).map((task) => [task.id, task.title]));
  return [
    '',
    '◆ 任务进度',
    renderProgressBar(counts.completed, taskIds.length),
    renderStatusSummary(counts),
    '',
    `◆ 任务 · ${taskIds.length}`,
    ...taskIds.map((taskId) =>
      renderTaskLine(snapshot.run, taskId, titles.get(taskId) ?? null),
    ),
  ];
}

/**
 * Git 区块只在 HEAD 偏离运行分支或处于 detached 状态时追加位置说明。
 *
 * 正常路径不重复打印同一条长分支名，异常位置仍保留完整诊断事实。
 */
function renderRepository(run: RunJson, git: RepositoryStatusFact): string[] {
  const headLocation =
    git.head.branch === run.repository.runBranch
      ? ''
      : ` · ${git.head.branch ?? 'detached'}`;
  return [
    '',
    '◆ Git',
    `  基线      ${run.repository.baseBranch} @ ${shortOid(run.repository.baseCommit)}`,
    `  运行分支  ${run.repository.runBranch}`,
    `  HEAD      ${shortOid(git.head.oid)}${headLocation}`,
  ];
}

function renderArtifacts(run: RunJson): string[] {
  return run.reportPath === null ? [] : ['', '◆ 产物', `  报告  ${run.reportPath}`];
}

export function renderStatus(
  snapshot: ConsistentSnapshot,
  git: RepositoryStatusFact,
): string[] {
  return [
    ...renderOverview(snapshot.run),
    ...renderLastError(snapshot.run),
    ...renderTasks(snapshot),
    ...renderRepository(snapshot.run, git),
    ...renderArtifacts(snapshot.run),
  ];
}

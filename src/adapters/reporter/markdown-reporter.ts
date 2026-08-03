/**
 * Markdown Reporter adapter (SPEC §14.4 Final Report, §5.5). Renders
 * `report.md` strictly from the committed facts handed in through
 * {@link GenerateReportInput} — run.json, tasks.json, Plan Revision
 * Snapshots and read-only Git facts. It never inspects Claude free-text
 * logs and never infers state; it does not claim independent security or
 * process-recovery verification without evidence (SPEC §14.4).
 *
 * Write protocol: render → redact the whole document through the
 * RedactionPort → write UTF-8 (no BOM) → re-read and compare bytes. Any
 * write or verification failure maps to `FINAL_REPORT_GENERATION_FAILED`
 * (SPEC §14.2, §15.3 report_error row).
 */
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { RedactionPort } from '../../application/ports/redaction.js';
import type {
  GenerateReportInput,
  ReporterPort,
} from '../../application/ports/ReporterPort.js';
import { ApexError } from '../../domain/errors.js';
import type { ErrorRecord } from '../../domain/schemas/error-record.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { TaskRuntimeState } from '../../domain/schemas/task-runtime-state.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';

const REPORT_STAGE = 'report';

/** 报告文件在状态目录中的固定相对路径（SPEC §4.1：report.md 位于 .apex-coding-agent/ 根）。 */
export const REPORT_RELATIVE_PATH = 'report.md';

export interface MarkdownReporterOptions {
  readonly stateDir: string;
  readonly fileSystem: FileSystemPort;
  readonly redaction: RedactionPort;
}

function reportGenerationFailed(message: string, cause?: unknown): ApexError {
  return new ApexError({
    code: 'FINAL_REPORT_GENERATION_FAILED',
    stage: REPORT_STAGE,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** 自由文本压成一行，避免破坏 Markdown 列表结构。 */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 状态目录内报告的绝对（宿主）路径。 */
function reportPathOf(stateDir: string): string {
  return `${stateDir}/${REPORT_RELATIVE_PATH}`;
}

function taskTitleOf(tasks: TasksJson | null, taskId: string): string | null {
  return tasks?.tasks.find((task) => task.id === taskId)?.title ?? null;
}

/** run.tasks 的确定性遍历顺序（Task ID 升序）。 */
function orderedTaskStates(run: RunJson): readonly TaskRuntimeState[] {
  return Object.keys(run.tasks)
    .sort()
    .map((taskId) => run.tasks[taskId]!);
}

function renderTaskRef(tasks: TasksJson | null, taskId: string): string {
  const title = taskTitleOf(tasks, taskId);
  return title === null ? `\`${taskId}\`` : `\`${taskId}\`：${inline(title)}`;
}

function renderErrorSummary(record: ErrorRecord): string {
  const association = [
    record.sessionId === null ? null : `Session \`${record.sessionId}\``,
    record.taskId === null ? null : `Task \`${record.taskId}\``,
  ]
    .filter((part) => part !== null)
    .join('，');
  const lines = [
    `- 错误码：${record.errorCode}（${record.errorClass}，stage：${record.stage}，时间：${record.at}）`,
    `- 错误摘要：${inline(record.message)}`,
  ];
  if (association.length > 0) lines.push(`- 关联：${association}`);
  if (record.toolSummary !== null) lines.push(`- 工具输出摘要：${inline(record.toolSummary)}`);
  return lines.join('\n');
}

/** 已提交事实中每个 completed Task 最终独立批准 Episode 的验收证据。 */
function renderAcceptanceEvidence(task: TaskRuntimeState): string[] {
  const evidence = task.taskReviewEpisodes.at(-1)?.acceptanceEvidence ?? [];
  if (evidence.length === 0) return [];
  const lines = ['- 验收证据（独立 Task Review）：'];
  for (const item of evidence) {
    lines.push(`  - 验收标准 ${item.criterionIndex + 1}：${item.status} — ${inline(item.evidence)}`);
  }
  return lines;
}

/** completed Run 报告（SPEC §14.4 的 12 项内容）。 */
function renderCompletedReport(input: GenerateReportInput): string {
  const { run, tasks, planRevisions, git } = input;
  const taskStates = orderedTaskStates(run);
  const completed = taskStates.filter((task) => task.status === 'completed');
  const skipped = taskStates.filter((task) => task.status === 'skipped');
  const finalReview = run.finalReviewEpisodes[run.finalReviewEpisodes.length - 1] ?? null;

  const out: string[] = [
    '# Run 完成报告',
    '',
    '> 本报告仅依据已提交事实（run.json、tasks.json、Plan Revision Snapshot 与 Git 只读状态）生成；',
    '> Reporter 不从 Claude 自由文本推断状态，也未执行独立的安全验证或进程恢复验证。',
    '',
    '## 基本信息',
    '',
    `- Run ID：\`${run.runId}\``,
    `- SPEC 路径：\`${run.spec.path}\``,
    `- SPEC SHA-256：\`${run.spec.sha256}\``,
    `- Run Branch：\`${run.repository.runBranch}\``,
    `- Base Branch：\`${run.repository.baseBranch}\`（\`${run.repository.baseBranchRef}\`）`,
    `- Base Commit：\`${run.repository.baseCommit}\``,
    `- Final Commit：\`${run.finalCommit ?? 'null'}\``,
    '',
    '## Plan Revision 历史',
    '',
  ];

  if (planRevisions.length === 0) {
    out.push('- 无 Plan Revision Snapshot 记录。');
  }
  for (const revision of planRevisions) {
    const parent =
      revision.parentPlanRevision === null ? '无' : `Revision ${revision.parentPlanRevision}`;
    out.push(
      `- Revision ${revision.planRevision}：trigger = ${revision.trigger.type}；` +
        `原因：${inline(revision.trigger.reason)}；父 Revision：${parent}；` +
        `生成于 ${revision.generatedAt}；包含 ${revision.tasks.length} 个 Task`,
    );
  }

  out.push('', '## Task 清单', '', '### 已完成（completed）', '');
  if (completed.length === 0) out.push('- 无。');
  for (const task of completed) out.push(`- ${renderTaskRef(tasks, task.taskId)}`);
  out.push('', '### 已跳过（skipped）', '');
  if (skipped.length === 0) out.push('- 无。');
  for (const task of skipped) {
    out.push(`- ${renderTaskRef(tasks, task.taskId)}；原因：${inline(task.skipReason ?? '未记录')}`);
  }

  out.push('', '## Task 执行明细', '');
  if (completed.length === 0) out.push('- 无 completed Task。', '');
  for (const task of completed) {
    out.push(`### ${renderTaskRef(tasks, task.taskId)}（completed）`, '');
    out.push(`- 最终 Checkpoint：\`${task.finalCheckpoint ?? 'null'}\``);
    out.push(...renderAcceptanceEvidence(task));
    if (task.executionEpisodes.length === 0) {
      out.push('- Execution Episode：无记录。');
    }
    task.executionEpisodes.forEach((episode, index) => {
      out.push(`- Execution Episode ${index + 1}：`);
      out.push(`  - Session：\`${episode.sessionId}\`；Plan Revision：${episode.planRevision}`);
      out.push(`  - 时间：${episode.startedAt} → ${episode.endedAt ?? '未结束'}`);
      out.push(`  - outcome：${episode.outcome ?? '未记录'}`);
      if (episode.summary !== null) out.push(`  - 摘要：${inline(episode.summary)}`);
      if (episode.finalCheckpoint !== null) {
        out.push(
          `  - Checkpoint：\`${episode.finalCheckpoint}\`` +
            (episode.checkpointReason === null ? '' : `（${episode.checkpointReason}）`),
        );
      }
      if (episode.intermediateCheckpoint !== null) {
        out.push(`  - 中间 Checkpoint：\`${episode.intermediateCheckpoint}\``);
      }
      for (const item of episode.acceptanceEvidence) {
        out.push(`  - 验收证据：验收标准 ${item.criterionIndex + 1}：${item.status} — ${inline(item.evidence)}`);
      }
    });
    /**
     * Task Review 与 Execution 分开展示，报告由此保留“谁产生候选、谁独立批准”
     * 的可审计关系；不能只展示最终 completed 状态而隐藏复核门禁。
     */
    if (task.taskReviewEpisodes.length === 0) {
      out.push('- Task Review Episode：无记录。');
    }
    task.taskReviewEpisodes.forEach((episode, index) => {
      out.push(`- Task Review Episode ${index + 1}：`);
      out.push(
        `  - Reviewer Session：\`${episode.sessionId}\`；` +
          `Execution Session：\`${episode.executionSessionId}\`；Plan Revision：${episode.planRevision}`,
      );
      out.push(`  - 候选 Checkpoint：\`${episode.candidateCheckpoint}\``);
      out.push(`  - 时间：${episode.startedAt} → ${episode.endedAt ?? '未结束'}`);
      out.push(`  - outcome：${episode.outcome ?? '未记录'}`);
      if (episode.summary !== null) out.push(`  - 摘要：${inline(episode.summary)}`);
      for (const test of episode.tests) {
        out.push(`  - 独立测试：\`${inline(test.command)}\` → ${test.result}`);
      }
      for (const item of episode.acceptanceEvidence) {
        out.push(
          `  - 独立验收证据：验收标准 ${item.criterionIndex + 1}：` +
            `${item.status} — ${inline(item.evidence)}`,
        );
      }
      for (const issue of episode.issues) out.push(`  - 发现问题：${inline(issue)}`);
    });
    out.push('');
  }

  out.push('## 中间 Checkpoint', '');
  if (run.intermediateCheckpoints.length === 0) {
    out.push('- 无中间 Checkpoint。');
  }
  for (const checkpoint of run.intermediateCheckpoints) {
    const source = checkpoint.taskId === null ? 'Final Review' : `Task \`${checkpoint.taskId}\``;
    const owner =
      checkpoint.ownerTaskId === null ? '尚未被接管' : `\`${checkpoint.ownerTaskId}\``;
    out.push(
      `- \`${checkpoint.oid}\`（${checkpoint.role}，Plan Revision ${checkpoint.planRevision}）：` +
        `${inline(checkpoint.summary)}；来源：${source}；最终接管 Task：${owner}`,
    );
  }

  out.push('', '## 测试结果（Claude 报告）', '', '### 各 Task 独立复核测试', '');
  const testedTasks = completed.filter(
    (task) => (task.taskReviewEpisodes.at(-1)?.tests.length ?? 0) > 0,
  );
  if (testedTasks.length === 0) out.push('- 无独立 Task Review 测试记录。');
  for (const task of testedTasks) {
    for (const test of task.taskReviewEpisodes.at(-1)!.tests) {
      out.push(`- \`${task.taskId}\` Task Review：\`${inline(test.command)}\` → ${test.result}`);
    }
  }
  out.push('', '### Final Review', '');
  if (finalReview === null) {
    out.push('- 无 Final Review Episode 记录。');
  } else {
    out.push(`- decision：${finalReview.decision ?? '未记录'}`);
    out.push(
      `- 审查 Task：${finalReview.reviewedTaskIds.map((id) => `\`${id}\``).join('、') || '无'}`,
    );
  }
  const finalReviewTests = input.finalReviewResult?.tests ?? [];
  if (finalReviewTests.length > 0) {
    for (const test of finalReviewTests) {
      out.push(`- Final Review：\`${inline(test.command)}\` → ${test.result}`);
    }
  } else if (finalReview !== null) {
    out.push('- Final Review 未报告测试记录。');
  }

  out.push('', '## Final Review 总结', '');
  if (finalReview === null) {
    out.push('- 无 Final Review Episode 记录。');
  } else {
    if (finalReview.summary !== null) out.push(`- 总结：${inline(finalReview.summary)}`);
    out.push(`- decision：${finalReview.decision ?? '未记录'}`);
    if (finalReview.changedAreas.length > 0) {
      out.push(`- 变更范围：${finalReview.changedAreas.map(inline).join('；')}`);
    }
    if (finalReview.checkpoint !== null) {
      out.push(
        `- Final Review Checkpoint：\`${finalReview.checkpoint}\`` +
          `（${finalReview.checkpointRole ?? '未知角色'}` +
          `${finalReview.checkpointReason === null ? '' : `，${finalReview.checkpointReason}`}）`,
      );
    }
  }

  out.push('', '## 剩余风险', '');
  const risks = completed.flatMap((task) =>
    (task.completedResult?.remainingRisks ?? []).map((risk) => ({ taskId: task.taskId, risk })),
  );
  const finalReviewRisks = input.finalReviewResult?.remainingRisks ?? [];
  if (risks.length === 0 && finalReviewRisks.length === 0) {
    out.push('- 各 Task 与 Final Review 均未报告剩余风险。');
  }
  for (const { taskId, risk } of risks) {
    out.push(`- \`${taskId}\`：${inline(risk)}`);
  }
  for (const risk of finalReviewRisks) {
    out.push(`- Final Review：${inline(risk)}`);
  }

  out.push(
    '',
    '## 查看或合并 Run Branch',
    '',
    `- Run Branch：\`${run.repository.runBranch}\`；Final Commit：\`${run.finalCommit ?? 'null'}\``,
    `- 查看提交历史：\`git log ${run.repository.baseCommit}..${run.finalCommit ?? 'HEAD'}\``,
    `- 查看完整差异：\`git diff ${run.repository.baseCommit}..${run.finalCommit ?? 'HEAD'}\``,
    `- 如需合并，请在审查后于 Base Branch（\`${run.repository.baseBranch}\`）上手动执行，` +
      `例如 \`git switch ${run.repository.baseBranch}\` 后 \`git merge ${run.repository.runBranch}\`。`,
    '- 以上命令仅供用户审查与合并参考；Coordinator 不执行合并、推送或对 Base Branch 的任何修改。',
    '',
    '## 生成时 Git 状态',
    '',
    `- 当前 HEAD：\`${git.headOid}\`（分支：${git.currentBranch === null ? 'detached' : `\`${git.currentBranch}\``}）`,
    '- 工作区状态（git status --porcelain）：',
  );
  if (git.statusEntries.length === 0) out.push('  - （干净，无条目）');
  for (const entry of git.statusEntries) out.push(`  - \`${entry}\``);

  out.push('');
  return out.join('\n');
}

/** failed / abandoned Run 报告（SPEC §14.4 的 5 条规则）。 */
function renderUnfinishedReport(input: GenerateReportInput): string {
  const { run, tasks, git } = input;
  const taskStates = orderedTaskStates(run);
  const completed = taskStates.filter((task) => task.status === 'completed');
  const failed = taskStates.filter((task) => task.status === 'failed');
  const notExecuted = taskStates.filter(
    (task) => task.status === 'pending' || task.status === 'running' || task.status === 'skipped',
  );

  const out: string[] = [
    '# Run 报告（未完成）',
    '',
    '> 本报告仅依据已提交事实（run.json、tasks.json、Plan Revision Snapshot 与 Git 只读状态）生成；',
    '> Reporter 不从 Claude 自由文本推断状态，也未执行独立的安全验证或进程恢复验证。',
    '',
    `**本 Run 未完成。**状态：${run.status}；终态时间：${run.terminalAt ?? '未记录'}。`,
    '',
    '## 基本信息',
    '',
    `- Run ID：\`${run.runId}\``,
    `- SPEC 路径：\`${run.spec.path}\``,
    `- SPEC SHA-256：\`${run.spec.sha256}\``,
    `- Plan Revision：${run.planRevision}`,
    '',
    '## 最近错误',
    '',
  ];

  if (run.lastError === null) {
    out.push('- 无 run.json lastError 记录。');
  } else {
    out.push(renderErrorSummary(run.lastError));
  }
  const failedWithRecord = failed.filter((task) => task.failure !== null);
  if (failedWithRecord.length > 0) {
    out.push('', '### 失败 Task 的错误', '');
    for (const task of failedWithRecord) {
      out.push(`#### ${renderTaskRef(tasks, task.taskId)}`, '');
      out.push(renderErrorSummary(task.failure!));
    }
  }

  out.push('', '## Task 清单', '', '### 已完成', '');
  if (completed.length === 0) out.push('- 无。');
  for (const task of completed) out.push(`- ${renderTaskRef(tasks, task.taskId)}`);
  out.push('', '### 失败', '');
  if (failed.length === 0) out.push('- 无。');
  for (const task of failed) out.push(`- ${renderTaskRef(tasks, task.taskId)}`);
  out.push('', '### 未执行', '');
  if (notExecuted.length === 0) out.push('- 无。');
  for (const task of notExecuted) {
    out.push(`- ${renderTaskRef(tasks, task.taskId)}（${task.status}）`);
  }

  out.push(
    '',
    '## Git 状态',
    '',
    `- Run Branch：\`${run.repository.runBranch}\``,
    `- 最后一个已确认 Checkpoint（run.json \`repository.expectedHead\`）：\`${run.repository.expectedHead}\``,
    `- 当前 HEAD：\`${git.headOid}\`（分支：${git.currentBranch === null ? 'detached' : `\`${git.currentBranch}\``}）` +
      '——仅为生成报告时的仓库状态，不是成功的 Final Commit',
    '- 工作区状态（git status --porcelain）：',
  );
  if (git.statusEntries.length === 0) out.push('  - （干净，无条目）');
  for (const entry of git.statusEntries) out.push(`  - \`${entry}\``);

  out.push(
    '',
    '## Final Commit',
    '',
    `本 Run 以 ${run.status} 结束，run.json \`finalCommit\` 为 null：**没有 Final Commit**。` +
      '当前 HEAD 不得视为成功的最终提交。',
    '',
  );
  return out.join('\n');
}

function renderReport(input: GenerateReportInput): string {
  return input.run.status === 'completed'
    ? renderCompletedReport(input)
    : renderUnfinishedReport(input);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function createMarkdownReporter(options: MarkdownReporterOptions): ReporterPort {
  const { stateDir, fileSystem, redaction } = options;
  return {
    async generateReport(input: GenerateReportInput): Promise<string> {
      const markdown = redaction.redactText(renderReport(input));
      const bytes = new TextEncoder().encode(markdown);
      const targetPath = reportPathOf(stateDir);
      try {
        await fileSystem.writeFile(targetPath, bytes);
      } catch (error) {
        throw reportGenerationFailed(`failed to write ${targetPath}`, error);
      }
      let reread: Uint8Array;
      try {
        reread = await fileSystem.readFile(targetPath);
      } catch (error) {
        throw reportGenerationFailed(`failed to reopen ${targetPath} after writing`, error);
      }
      if (!bytesEqual(reread, bytes)) {
        throw reportGenerationFailed(
          `${targetPath} verification failed: re-read bytes differ from the written bytes`,
        );
      }
      return REPORT_RELATIVE_PATH;
    },
  };
}

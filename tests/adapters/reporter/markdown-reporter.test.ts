/**
 * Markdown Reporter adapter (SPEC §14.4, §5.5): the report is rendered
 * strictly from committed facts, redacted as a whole before writing, and
 * verified by a byte-for-byte re-read. completed Runs cover the §14.4
 * 12 items; failed/abandoned Runs follow the 5 rules (unfinished marker,
 * redacted error summary, three-way task classification, expectedHead as
 * the last confirmed checkpoint, and HEAD never posed as a Final Commit).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import {
  createMarkdownReporter,
  REPORT_RELATIVE_PATH,
} from '../../../src/adapters/reporter/markdown-reporter.js';
import type {
  GenerateReportInput,
  ReporterPort,
  ReportGitFact,
} from '../../../src/application/ports/ReporterPort.js';
import type { RunJson } from '../../../src/domain/schemas/run-json.js';
import type { TaskExecutionEpisode } from '../../../src/domain/schemas/task-execution-episode.js';
import {
  mkErrorRecord,
  mkResult,
  mkRun,
  mkTask,
  mkTaskState,
  OID_B,
  OID_C,
  OID_D,
  RUN_ID,
  SHA256_A,
  SHA256_C,
  T0,
  T1,
  UUID_1,
  UUID_2,
  UUID_3,
} from '../../domain/fixtures.js';
import { expectApexErrorAsync, mkSnapshot, mkTasks, STATE_DIR } from '../fixtures.js';
import { InMemoryFileSystem } from '../state/in-memory-file-system.js';

const OID_TASK_1 = 'e'.repeat(40);
const OID_TASK_2 = 'f'.repeat(40);
const OID_INTERMEDIATE = OID_C;
const OID_FINAL = OID_D;
const RUN_BRANCH = `apex-coding-agent/${RUN_ID}`;
const REPORT_PATH = `${STATE_DIR}/${REPORT_RELATIVE_PATH}`;

let fs: InMemoryFileSystem;
let reporter: ReporterPort;

beforeEach(() => {
  fs = new InMemoryFileSystem();
  reporter = createMarkdownReporter({
    stateDir: STATE_DIR,
    fileSystem: fs,
    redaction: createRedactor(),
  });
});

function mkEpisode(overrides: Partial<TaskExecutionEpisode> = {}): TaskExecutionEpisode {
  return {
    sessionId: UUID_1,
    taskId: 'TASK-001',
    planRevision: 1,
    specSha256Before: SHA256_A,
    specSha256After: SHA256_A,
    startedAt: T0,
    endedAt: T1,
    outcome: 'completed',
    summary: '完成 TASK-001 的实现',
    acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: '单测通过' }],
    finalCheckpoint: OID_TASK_1,
    intermediateCheckpoint: null,
    checkpointReason: 'committed_remaining_changes',
    error: null,
    ...overrides,
  };
}

/** §14.3 形态的成功 Run：TASK-001/002 completed、TASK-003 skipped、一个已被接管的中间 Checkpoint。 */
function mkCompletedRun(): RunJson {
  return mkRun({
    status: 'completed',
    planRevision: 2,
    stateRevision: 8,
    tasksSha256: SHA256_C,
    repository: {
      root: 'C:/repo',
      baseBranch: 'main',
      baseBranchRef: 'refs/heads/main',
      baseCommit: OID_B,
      runBranch: RUN_BRANCH,
      expectedHead: OID_FINAL,
    },
    tasks: {
      'TASK-001': mkTaskState('TASK-001', 'completed', {
        finalCheckpoint: OID_TASK_1,
        executionEpisodes: [mkEpisode()],
      }),
      'TASK-002': mkTaskState('TASK-002', 'completed', {
        finalCheckpoint: OID_TASK_2,
        executionEpisodes: [
          mkEpisode({
            sessionId: UUID_2,
            taskId: 'TASK-002',
            planRevision: 2,
            summary: '完成 TASK-002 的实现',
            finalCheckpoint: OID_TASK_2,
            intermediateCheckpoint: OID_INTERMEDIATE,
          }),
        ],
        completedResult: mkResult({ remainingRisks: ['极端并发下可能超时'] }),
      }),
      'TASK-003': mkTaskState('TASK-003', 'skipped'),
    },
    intermediateCheckpoints: [
      {
        oid: OID_INTERMEDIATE,
        role: 'task-intermediate',
        sourceSessionId: UUID_2,
        taskId: 'TASK-002',
        planRevision: 1,
        summary: '保留 TASK-002 中间成果',
        ownerTaskId: 'TASK-002',
      },
    ],
    finalReviewEpisodes: [
      {
        sessionId: UUID_3,
        planRevision: 2,
        specSha256Before: SHA256_A,
        specSha256After: SHA256_A,
        startedAt: T0,
        endedAt: T1,
        decision: 'completed',
        summary: '整体验收通过',
        reviewedTaskIds: ['TASK-001', 'TASK-002'],
        changedAreas: ['src'],
        checkpointRole: 'final-review-final',
        checkpoint: OID_FINAL,
        checkpointReason: 'committed_remaining_changes',
        error: null,
      },
    ],
    finalCommit: OID_FINAL,
    terminalAt: T1,
    updatedAt: T1,
  });
}

function mkCompletedInput(): GenerateReportInput {
  return {
    run: mkCompletedRun(),
    tasks: mkTasks(2),
    planRevisions: [mkSnapshot(1), mkSnapshot(2)],
    git: { currentBranch: RUN_BRANCH, headOid: OID_FINAL, statusEntries: [] },
    finalReviewResult: {
      decision: 'completed',
      summary: '整体复核通过',
      reviewedTaskIds: ['TASK-001', 'TASK-002'],
      tests: [{ command: 'npm run verify', result: 'passed' }],
      changedAreas: [],
      remainingRisks: ['依赖外部服务可用性'],
      replanReason: null,
    },
  };
}

/** 执行中失败的 Run：TASK-001 completed、TASK-002 failed、TASK-003 未执行。 */
function mkFailedInput(): GenerateReportInput {
  const plan = [mkTask('TASK-001'), mkTask('TASK-002', ['TASK-001']), mkTask('TASK-003', ['TASK-002'])];
  const run = mkRun({
    status: 'failed',
    planRevision: 1,
    stateRevision: 5,
    tasksSha256: SHA256_C,
    tasks: {
      'TASK-001': mkTaskState('TASK-001', 'completed'),
      'TASK-002': mkTaskState('TASK-002', 'failed', {
        failure: mkErrorRecord({ taskId: 'TASK-002', sessionId: UUID_2 }),
      }),
      'TASK-003': mkTaskState('TASK-003', 'pending'),
    },
    lastError: mkErrorRecord({ taskId: 'TASK-002', sessionId: UUID_2 }),
    terminalAt: T1,
    updatedAt: T1,
  });
  const git: ReportGitFact = {
    currentBranch: RUN_BRANCH,
    headOid: OID_B,
    statusEntries: [' M src/index.ts', '?? scratch.txt'],
  };
  return { run, tasks: mkTasks(1, plan), planRevisions: [mkSnapshot(1, plan)], git, finalReviewResult: null };
}

describe('completed Run report (SPEC §14.4)', () => {
  it('writes report.md into the state directory and returns the relative path', async () => {
    const result = await reporter.generateReport(mkCompletedInput());
    expect(result).toBe('report.md');
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown.startsWith('# Run 完成报告')).toBe(true);
    // UTF-8 without BOM.
    expect([...fs.files.get(REPORT_PATH)!.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('covers SPEC identity, Run ID, Run Branch, Base/Final Commit', async () => {
    await reporter.generateReport(mkCompletedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain(`- SPEC 路径：\`docs/SPEC.md\``);
    expect(markdown).toContain(`- SPEC SHA-256：\`${SHA256_A}\``);
    expect(markdown).toContain(`- Run ID：\`${RUN_ID}\``);
    expect(markdown).toContain(`- Run Branch：\`${RUN_BRANCH}\``);
    expect(markdown).toContain(`- Base Commit：\`${OID_B}\``);
    expect(markdown).toContain(`- Final Commit：\`${OID_FINAL}\``);
  });

  it('covers plan revision history with trigger type and reason', async () => {
    await reporter.generateReport(mkCompletedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('## Plan Revision 历史');
    expect(markdown).toContain('Revision 1：trigger = initial；原因：initial planning');
    expect(markdown).toContain('Revision 2：trigger = spec_changed；原因：spec changed');
  });

  it('covers completed/skipped task lists and per-task episodes, evidence, checkpoints', async () => {
    await reporter.generateReport(mkCompletedInput());
    const markdown = fs.readText(REPORT_PATH);
    // completed / skipped 清单
    expect(markdown).toContain('### 已完成（completed）\n\n- `TASK-001`：Title TASK-001');
    expect(markdown).toContain('- `TASK-002`：Title TASK-002');
    // TASK-003 已被 Revision 2 省略，tasks.json 中无标题，回退为纯 ID。
    expect(markdown).toContain(
      '### 已跳过（skipped）\n\n- `TASK-003`；原因：Omitted by plan revision 2',
    );
    // Execution Episode：outcome、时间、摘要
    expect(markdown).toContain('- Execution Episode 1：');
    expect(markdown).toContain(`- Session：\`${UUID_1}\`；Plan Revision：1`);
    expect(markdown).toContain(`- 时间：${T0} → ${T1}`);
    expect(markdown).toContain('- outcome：completed');
    expect(markdown).toContain('- 摘要：完成 TASK-001 的实现');
    // 验收证据与最终 Checkpoint
    expect(markdown).toContain('- 验收标准 1：satisfied — evidence for AC-1');
    expect(markdown).toContain(`- 最终 Checkpoint：\`${OID_TASK_1}\``);
    expect(markdown).toContain(`- Checkpoint：\`${OID_TASK_2}\`（committed_remaining_changes）`);
  });

  it('covers intermediate checkpoints with their adopting task', async () => {
    await reporter.generateReport(mkCompletedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('## 中间 Checkpoint');
    expect(markdown).toContain(`- \`${OID_INTERMEDIATE}\`（task-intermediate，Plan Revision 1）`);
    expect(markdown).toContain('最终接管 Task：`TASK-002`');
  });

  it('covers Claude-reported test results, final review summary and remaining risks', async () => {
    await reporter.generateReport(mkCompletedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('## 测试结果（Claude 报告）');
    expect(markdown).toContain('- `TASK-001`：`npm test` → passed');
    expect(markdown).toContain('- `TASK-002`：`npm test` → passed');
    expect(markdown).toContain('- Final Review：`npm run verify` → passed');
    expect(markdown).toContain('## Final Review 总结');
    expect(markdown).toContain('- 总结：整体验收通过');
    expect(markdown).toContain('- decision：completed');
    expect(markdown).toContain('审查 Task：`TASK-001`、`TASK-002`');
    expect(markdown).toContain('## 剩余风险');
    expect(markdown).toContain('- `TASK-002`：极端并发下可能超时');
    expect(markdown).toContain('- Final Review：依赖外部服务可用性');
  });

  it('explains how the user inspects or merges the run branch (Coordinator never merges)', async () => {
    await reporter.generateReport(mkCompletedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('## 查看或合并 Run Branch');
    expect(markdown).toContain(`git log ${OID_B}..${OID_FINAL}`);
    expect(markdown).toContain(`git merge ${RUN_BRANCH}`);
    expect(markdown).toContain('Coordinator 不执行合并、推送或对 Base Branch 的任何修改');
  });

  it('redacts secrets from the whole document before writing', async () => {
    const run = mkCompletedRun();
    run.tasks['TASK-001']!.executionEpisodes[0]!.summary =
      '完成（临时密钥 AKIAIOSFODNN7EXAMPLE 不应落盘）';
    await reporter.generateReport({ ...mkCompletedInput(), run });
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(markdown).toContain('[REDACTED]');
  });
});

describe('failed/abandoned Run report (SPEC §14.4)', () => {
  it('marks the run as unfinished with status and terminalAt', async () => {
    await reporter.generateReport(mkFailedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('# Run 报告（未完成）');
    expect(markdown).toContain(`**本 Run 未完成。**状态：failed；终态时间：${T1}。`);
  });

  it('reports the latest error code and the semantics-preserving error summary', async () => {
    await reporter.generateReport(mkFailedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('## 最近错误');
    expect(markdown).toContain('- 错误码：CLAUDE_EXIT_NONZERO（claude_error，stage：execution');
    expect(markdown).toContain('- 错误摘要：claude exited with code 1');
    expect(markdown).toContain('### 失败 Task 的错误');
    expect(markdown).toContain('#### `TASK-002`：Title TASK-002');
  });

  it('classifies tasks into completed / failed / not executed', async () => {
    await reporter.generateReport(mkFailedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('### 已完成\n\n- `TASK-001`：Title TASK-001');
    expect(markdown).toContain('### 失败\n\n- `TASK-002`：Title TASK-002');
    expect(markdown).toContain('### 未执行\n\n- `TASK-003`：Title TASK-003（pending）');
  });

  it('labels expectedHead as the last confirmed checkpoint and shows the git status', async () => {
    await reporter.generateReport(mkFailedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain(`- Run Branch：\`${RUN_BRANCH}\``);
    expect(markdown).toContain(
      `最后一个已确认 Checkpoint（run.json \`repository.expectedHead\`）：\`${OID_B}\``,
    );
    expect(markdown).toContain(`- 当前 HEAD：\`${OID_B}\``);
    expect(markdown).toContain('` M src/index.ts`');
    expect(markdown).toContain('`?? scratch.txt`');
  });

  it('never presents the current HEAD as a successful Final Commit', async () => {
    await reporter.generateReport(mkFailedInput());
    const markdown = fs.readText(REPORT_PATH);
    expect(markdown).toContain('没有 Final Commit');
    expect(markdown).toContain('当前 HEAD 不得视为成功的最终提交');
    // 不存在 "Final Commit：<oid>" 形式的冒充行。
    expect(markdown).not.toMatch(/Final Commit[：:]\s*`?[0-9a-f]{40}/);
  });
});

describe('write protocol failures', () => {
  it('maps write failures to FINAL_REPORT_GENERATION_FAILED', async () => {
    fs.injectFailure({ op: 'writeFile', error: new Error('disk full') });
    const error = await expectApexErrorAsync(
      () => reporter.generateReport(mkCompletedInput()),
      'FINAL_REPORT_GENERATION_FAILED',
    );
    expect(error.stage).toBe('report');
    expect(fs.files.has(REPORT_PATH)).toBe(false);
  });

  it('maps re-read failures to FINAL_REPORT_GENERATION_FAILED', async () => {
    fs.injectFailure({ op: 'readFile', error: new Error('io error') });
    await expectApexErrorAsync(
      () => reporter.generateReport(mkCompletedInput()),
      'FINAL_REPORT_GENERATION_FAILED',
    );
  });

  it('maps a byte mismatch on re-read to FINAL_REPORT_GENERATION_FAILED', async () => {
    fs.readInterceptor = (_path, bytes) => {
      const corrupted = bytes.slice();
      corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
      return corrupted;
    };
    await expectApexErrorAsync(
      () => reporter.generateReport(mkCompletedInput()),
      'FINAL_REPORT_GENERATION_FAILED',
    );
  });
});

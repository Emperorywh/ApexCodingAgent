#!/usr/bin/env node
// NFR-007 performance acceptance harness (docs/SPEC.md §NFR-007, lines 2230-2248).
//
// Fixed fixture: 50 pending Task, 200 historical Execution Episode, 10 Plan Revision.
// Each metric: `warmup` iterations (default 20), then `samples` consecutive measured
// iterations (default 200); P95 by nearest-rank (sorted[ceil(0.95*n)], 1-based rank).
//
// Metrics and thresholds:
//   1. task-selection  本地 Task 选择            P95 < 100 ms  (selectReadyTask, pure)
//   2. state-read      本地状态读取              P95 < 500 ms  (readConsistentSnapshot, real I/O)
//   3. status-cli      `status` CLI              P95 < 2 s     (real spawned process, incl. Node boot)
//   4. startup-checks  启动检查(不含 Claude/Git) P95 < 2 s     (real StartRun + fake Git/Claude ports)
//
// Claude calls never enter samples; only metric 4 substitutes a Fake Git Port.
//
// Fixture design note (disclosed): the 50 pending tasks form a linear dependency
// chain (TASK-00n dependsOn TASK-00(n-1)) stored in REVERSE tasks.json order, so
// every selectReadyTask sample performs the full 50-task scan before returning
// TASK-001 — the worst case over the fixed "50 pending Task" fixture.
//
// Usage:
//   node scripts/perf-nfr007.mjs [--quick] [--samples N] [--warmup M] [--out <path>] [--label <string>]
//   --quick: warmup 3, samples 10 (self-test only; the official protocol is 20/200).
//
// Exit codes: 0 all metrics PASS, 1 any metric FAIL, 2 harness/fixture error.
// The fixture (a real git repo under os.tmpdir()) is removed on exit.

import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Compiled application modules (never src/; no new dependencies).
import { selectReadyTask } from '../dist/domain/task-state.js';
import { validate } from '../dist/domain/schemas/index.js';
import { createJsonStateStore } from '../dist/adapters/state/json-state-store.js';
import { serializeJson, sha256Hex } from '../dist/adapters/state/json-file-writer.js';
import { createNodeFileSystem } from '../dist/adapters/filesystem/node-file-system.js';
import { createSystemClock } from '../dist/adapters/clock/system-clock.js';
import { createRedactor } from '../dist/adapters/redaction/redactor.js';
import { createInterruptController } from '../dist/application/interrupt.js';
import { createNullLogger } from '../dist/application/ports/logger.js';
import { createMarkdownReporter } from '../dist/adapters/reporter/markdown-reporter.js';
import { createRunArchiver } from '../dist/adapters/state/run-archiver.js';
import { createStartRun } from '../dist/application/usecases/start-run.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliMainPath = path.join(repoRoot, 'dist', 'interfaces', 'cli', 'main.js');

// Fixed fixture dimensions (SPEC §NFR-007 protocol).
const TASK_COUNT = 50;
const EPISODE_COUNT = 200;
const PLAN_REVISIONS = 10;

const METRICS = [
  { key: 'task-selection', description: '本地 Task 选择 (selectReadyTask)', thresholdMs: 100 },
  { key: 'state-read', description: '本地状态读取 (readConsistentSnapshot)', thresholdMs: 500 },
  { key: 'status-cli', description: 'status (CLI, spawned process)', thresholdMs: 2000 },
  {
    key: 'startup-checks',
    description: '启动检查，不含 Claude/Git (StartRun + fake ports)',
    thresholdMs: 2000,
  },
];

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseCount(value, flag, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} requires an integer >= ${minimum}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = { quick: false, samples: undefined, warmup: undefined, out: undefined, label: 'nfr007' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quick') opts.quick = true;
    else if (arg === '--samples') opts.samples = parseCount(argv[++i], '--samples', 1);
    else if (arg === '--warmup') opts.warmup = parseCount(argv[++i], '--warmup', 0);
    else if (arg === '--out') {
      opts.out = argv[++i];
      if (opts.out === undefined) throw new Error('--out requires a path');
    } else if (arg === '--label') {
      opts.label = argv[++i];
      if (opts.label === undefined) throw new Error('--label requires a value');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    quick: opts.quick,
    warmup: opts.warmup ?? (opts.quick ? 3 : 20),
    samples: opts.samples ?? (opts.quick ? 10 : 200),
    out: opts.out,
    label: opts.label,
  };
}

// ---------------------------------------------------------------------------
// Statistics (P95 by nearest-rank, 1-based: sorted[ceil(0.95*n) - 1])
// ---------------------------------------------------------------------------

function computeStats(rawSamples) {
  const sorted = [...rawSamples].sort((a, b) => a - b);
  const n = sorted.length;
  const p95 = sorted[Math.ceil(0.95 * n) - 1];
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { min: sorted[0], median, p95, max: sorted[n - 1] };
}

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

function taskId(n) {
  return `TASK-${String(n).padStart(3, '0')}`;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 50 pending tasks: linear chain TASK-00n dependsOn TASK-00(n-1), stored reversed. */
function buildPlannedTasks() {
  const tasks = [];
  for (let n = TASK_COUNT; n >= 1; n -= 1) {
    tasks.push({
      id: taskId(n),
      title: `Fixture task ${n}`,
      objective: `Objective of fixture task ${n}`,
      dependsOn: n > 1 ? [taskId(n - 1)] : [],
      acceptanceCriteria: [`Acceptance criterion of fixture task ${n}`],
      verificationHints: [`npm test -- task-${n}`],
      likelyPaths: [`src/fixture/task-${n}.ts`],
      estimatedSize: 'small',
      context: `Context of fixture task ${n}`,
    });
  }
  return tasks;
}

/** 200 ended episodes: 20 per plan revision, 4 per task, 90% completed / 10% replan. */
function buildEpisodes(specSha256) {
  const episodes = [];
  const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < EPISODE_COUNT; i += 1) {
    const completed = i % 10 !== 9;
    const startedMs = baseMs + i * 60_000;
    episodes.push({
      sessionId: randomUUID(),
      taskId: taskId((i % TASK_COUNT) + 1),
      planRevision: 1 + Math.floor(i / (EPISODE_COUNT / PLAN_REVISIONS)),
      specSha256Before: specSha256,
      specSha256After: specSha256,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(startedMs + 5 * 60_000).toISOString(),
      outcome: completed ? 'completed' : 'replan_required',
      summary: completed
        ? `fixture episode ${i} completed`
        : `fixture episode ${i} requested a replan`,
      acceptanceEvidence: [],
      finalCheckpoint: completed ? randomBytes(20).toString('hex') : null,
      intermediateCheckpoint: null,
      checkpointReason: completed ? 'committed_remaining_changes' : 'no_intermediate_changes',
      error: null,
    });
  }
  return episodes;
}

function assertFixtureValid(schemaName, value, fileLabel) {
  const result = validate(schemaName, value);
  if (!result.valid) {
    const detail = result.issues
      .map((issue) => `${issue.path} (${issue.keyword}): ${issue.message}`)
      .join('; ');
    throw new Error(`fixture ${fileLabel} failed the app's own ${schemaName} validation: ${detail}`);
  }
}

async function createFixture() {
  const root = path.join(os.tmpdir(), `apex-perf-nfr007-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const rootSlash = root.replace(/\\/g, '/');

  // A real git repo so metric 3 (status CLI) exercises the real Git adapter.
  git(['init', '-b', 'main'], root);
  const specContent =
    '# NFR-007 Fixture SPEC\n\nDeterministic synthetic fixture for the NFR-007 performance harness.\n';
  await fs.writeFile(path.join(root, 'SPEC.md'), specContent, 'utf8');
  git(['add', 'SPEC.md'], root);
  git(
    [
      '-c',
      'user.name=NFR-007 Fixture',
      '-c',
      'user.email=nfr007@fixture.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture: SPEC',
    ],
    root,
  );
  const headOid = git(['rev-parse', 'HEAD'], root).trim();
  // Mirror GitPort.ensureStateDirectoryExcluded (SPEC §3.1): real exclude file, never .gitignore.
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\n.apex-coding-agent/\n', 'utf8');
  const specSha256 = sha256Hex(new TextEncoder().encode(specContent));

  const runId = `RUN-${randomUUID()}`;
  const generatedAt = '2026-01-01T00:00:00.000Z';
  const plannedTasks = buildPlannedTasks();
  const episodes = buildEpisodes(specSha256);

  const tasks = {};
  for (let n = 1; n <= TASK_COUNT; n += 1) {
    const id = taskId(n);
    tasks[id] = {
      taskId: id,
      status: 'pending',
      executionEpisodes: episodes.filter((episode) => episode.taskId === id),
      completedResult: null,
      finalCheckpoint: null,
      skipReason: null,
      failure: null,
    };
  }

  const tasksValue = {
    schemaVersion: 1,
    runId,
    planRevision: PLAN_REVISIONS,
    specPath: 'SPEC.md',
    specSha256,
    generatedAt,
    plannerSessionId: randomUUID(),
    summary: 'NFR-007 fixture plan (50 pending tasks)',
    assumptions: ['synthetic deterministic fixture'],
    retainedCheckpointDispositions: [],
    tasks: plannedTasks,
  };
  // tasks.json bytes first; run.json tasksSha256 is the SHA-256 of those exact raw bytes.
  const tasksBytes = serializeJson(tasksValue);
  const tasksSha256 = sha256Hex(tasksBytes);

  const runValue = {
    schemaVersion: 1,
    stateRevision: 481,
    runId,
    status: 'running',
    spec: { path: 'SPEC.md', sha256: specSha256 },
    planRevision: PLAN_REVISIONS,
    tasksSha256,
    runSettings: { executionPermissionMode: 'auto', claudeCliPath: null, gitCliPath: null },
    repository: {
      root: rootSlash,
      baseBranch: 'main',
      baseBranchRef: 'refs/heads/main',
      baseCommit: headOid,
      runBranch: `apex-coding-agent/${runId}`,
      expectedHead: headOid,
    },
    currentTaskId: null,
    activeSession: null,
    tasks,
    intermediateCheckpoints: [],
    finalReviewEpisodes: [],
    lastError: null,
    finalCommit: null,
    reportPath: null,
    /*
     * 性能夹具必须与当前 RunJson 写入契约完全一致；resumePoint 是显式
     * 运行事实，基准脚本不使用旧格式读取迁移来掩盖 fixture 漂移。
     */
    resumePoint: null,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    terminalAt: null,
  };

  const snapshots = [];
  for (let revision = 1; revision <= PLAN_REVISIONS; revision += 1) {
    snapshots.push({
      schemaVersion: 1,
      runId,
      planRevision: revision,
      parentPlanRevision: revision === 1 ? null : revision - 1,
      trigger:
        revision === 1
          ? { type: 'initial', reason: 'initial fixture planning', sourceSessionId: null }
          : {
              type: 'execution_replan',
              reason: `fixture replan at revision ${revision}`,
              sourceSessionId: randomUUID(),
            },
      specPath: 'SPEC.md',
      specSha256,
      generatedAt: new Date(Date.parse(generatedAt) + revision * 1000).toISOString(),
      plannerSessionId: randomUUID(),
      summary: `fixture plan revision ${revision}`,
      assumptions: ['synthetic deterministic fixture'],
      retainedCheckpointDispositions: [],
      tasks: plannedTasks,
    });
  }

  // Validate every fixture document with the app's OWN compiled ajv validators
  // before any byte is measured; fail loudly on the first invalid file.
  assertFixtureValid('TasksJson', tasksValue, 'tasks.json');
  assertFixtureValid('RunJson', runValue, 'run.json');
  for (const snapshot of snapshots) {
    assertFixtureValid('PlanRevisionSnapshot', snapshot, `plans/${snapshot.planRevision}.json`);
  }

  const stateDirFs = path.join(root, '.apex-coding-agent');
  await fs.mkdir(path.join(stateDirFs, 'plans'), { recursive: true });
  await fs.writeFile(path.join(stateDirFs, 'tasks.json'), tasksBytes);
  await fs.writeFile(path.join(stateDirFs, 'run.json'), serializeJson(runValue));
  for (const snapshot of snapshots) {
    await fs.writeFile(
      path.join(stateDirFs, 'plans', `${snapshot.planRevision}.json`),
      serializeJson(snapshot),
    );
  }

  return {
    root,
    rootSlash,
    stateDir: `${rootSlash}/.apex-coding-agent`,
    runId,
    headOid,
    specSha256,
    runValue,
    tasksValue,
  };
}

/** Recursive path → SHA-256 map of the whole fixture (used for the metric 4 read-only check). */
async function hashFixtureTree(root) {
  const entries = new Map();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        entries.set(
          path.relative(root, full).replace(/\\/g, '/'),
          createHash('sha256').update(await fs.readFile(full)).digest('hex'),
        );
      }
    }
  }
  await walk(root);
  return entries;
}

function assertTreeUnchanged(before, after) {
  if (before.size !== after.size) {
    throw new Error(
      `metric 4 is not read-only: fixture file count changed ${before.size} -> ${after.size}`,
    );
  }
  for (const [file, hash] of before) {
    if (!after.has(file)) throw new Error(`metric 4 is not read-only: ${file} disappeared`);
    if (after.get(file) !== hash) throw new Error(`metric 4 is not read-only: ${file} changed`);
  }
}

// ---------------------------------------------------------------------------
// Metric 3: real `status` CLI process
// ---------------------------------------------------------------------------

function runStatusCli(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliMainPath, 'status'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Metric 4: real StartRun with hand-written fake GitPort / ClaudeRuntimePort
// ---------------------------------------------------------------------------

function createFakeGitPort(fixture) {
  const mustNotReach = (name) => async () => {
    throw new Error(`fake GitPort.${name} must not be called on the metric-4 path`);
  };
  return {
    assertAvailable: async () => {},
    resolveRepositoryRoot: async () => fixture.rootSlash,
    readHead: async () => ({ oid: fixture.headOid, branch: 'main' }),
    resolveSpec: async () => ({
      gitPath: 'SPEC.md',
      absolutePath: `${fixture.rootSlash}/SPEC.md`,
      sha256: fixture.specSha256,
    }),
    assertStateDirectoryUntracked: async () => {},
    assertWorkingTreeClean: async () => {},
    assertSpecNotStaged: async () => {},
    ensureStateDirectoryExcluded: mustNotReach('ensureStateDirectoryExcluded'),
    createRunBranch: mustNotReach('createRunBranch'),
    assertSessionStart: mustNotReach('assertSessionStart'),
    assertResumePosition: mustNotReach('assertResumePosition'),
    assertSessionEnd: mustNotReach('assertSessionEnd'),
    createTaskCheckpoint: mustNotReach('createTaskCheckpoint'),
    createIntermediateCheckpoint: mustNotReach('createIntermediateCheckpoint'),
    createFinalReviewCheckpoint: mustNotReach('createFinalReviewCheckpoint'),
    readSpecFact: mustNotReach('readSpecFact'),
    readRepositoryStatus: mustNotReach('readRepositoryStatus'),
  };
}

function createFakeClaudePort() {
  return {
    probeCapabilities: async () => ({
      version: 'nfr007-fake-claude 0.0.0',
      capabilities: ['--print', '--output-format stream-json', '--session-id', '--permission-mode'],
    }),
    invoke: async () => {
      throw new Error('fake ClaudeRuntimePort.invoke must not be called on the metric-4 path');
    },
    abort: () => {},
  };
}

/** Mirrors the production StartRunDeps wiring of src/bootstrap/composition-root.ts. */
function createMetric4StartRun(fixture, fileSystem) {
  const clock = createSystemClock();
  const redaction = createRedactor();
  const output = { writeLine: () => {} };
  const interrupt = createInterruptController();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const interruptWaitMs = 10_000;
  const fakeGit = createFakeGitPort(fixture);
  const fakeClaude = createFakeClaudePort();

  return createStartRun({
    fileSystem,
    clock,
    redaction,
    output,
    interrupt,
    wait,
    interruptWaitMs,
    /*
     * Metric 4 在现有非终态 Run 门禁处结束，不会真正调度心跳；仍完整提供
     * 当前 RunCommandDeps 契约，防止性能脚本靠缺失依赖误走异常分支。
     */
    scheduleInterval: () => () => {},
    makeGitPort: () => fakeGit,
    makeClaudePort: () => fakeClaude,
    makeLogger: () => createNullLogger(),
    makeStateStore: (stateDir) =>
      createJsonStateStore({ stateDir, fs: fileSystem, redaction }),
    makeBoundDeps: ({ stateDir, git, claude, capabilityReport, logger }) => ({
      stateDir,
      /*
       * 性能 Harness 复用生产 State Store 契约，写入前安全断言不能因基准
       * 测试而旁路；语料本身不含秘密，因此不会改变被测工作量的性质。
       */
      stateStore: createJsonStateStore({ stateDir, fs: fileSystem, redaction }),
      git,
      claude,
      clock,
      fileSystem,
      redaction,
      reporter: createMarkdownReporter({ stateDir, fileSystem, redaction }),
      archiver: createRunArchiver({ stateDir, fs: fileSystem, clock }),
      output,
      logger,
      interrupt,
      wait,
      interruptWaitMs,
      sessionHeartbeatMs: 15_000,
      capabilityReport,
    }),
  });
}

// ---------------------------------------------------------------------------
// Measurement loop
// ---------------------------------------------------------------------------

/**
 * Warmup iterations are asserted but not recorded; then `samples` consecutive
 * iterations are timed with performance.now() around exactly the operation
 * (awaited inside the timing, so async overhead of the operation is included).
 */
async function measureMetric(definition, run, options) {
  const isSync = definition.key === 'task-selection';
  for (let i = 0; i < options.warmup; i += 1) {
    if (isSync) run();
    else await run();
  }
  const rawSamples = [];
  for (let i = 0; i < options.samples; i += 1) {
    const t0 = performance.now();
    if (isSync) run();
    else await run();
    rawSamples.push(performance.now() - t0);
  }
  const stats = computeStats(rawSamples);
  return {
    unit: 'ms',
    thresholdMs: definition.thresholdMs,
    warmup: options.warmup,
    samples: rawSamples,
    p95: stats.p95,
    min: stats.min,
    median: stats.median,
    max: stats.max,
    pass: stats.p95 < definition.thresholdMs,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function machineSummary() {
  const cpus = os.cpus();
  const releaseParts = os.release().split('.');
  return {
    nodeVersion: process.version,
    platform: process.platform,
    osRelease: os.release(),
    // Windows release 三元组（如 10.0.22631）中的 build 号；Unix 的内核版本不适用。
    windowsBuild:
      process.platform === 'win32' && releaseParts.length >= 3 ? releaseParts[2] : null,
    cpu: cpus.length > 0 ? cpus[0].model : 'unknown',
    logicalCpus: cpus.length,
    totalMemBytes: os.totalmem(),
  };
}

function formatMs(value) {
  return value.toFixed(3).padStart(9);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const machine = machineSummary();
  console.log(
    `NFR-007 performance harness — warmup ${options.warmup}, samples ${options.samples} per metric` +
      `${options.quick ? ' (--quick self-test profile)' : ' (official protocol)'}`,
  );
  const osDetail =
    machine.platform === 'win32' && machine.windowsBuild !== null
      ? ` (Windows build ${machine.windowsBuild})`
      : '';
  console.log(
    `machine: node ${machine.nodeVersion} | ${machine.platform} ${machine.osRelease}` +
      `${osDetail} | ${machine.cpu} | ${machine.logicalCpus} logical CPUs | ` +
      `${(machine.totalMemBytes / 1024 ** 3).toFixed(1)} GB RAM`,
  );

  const fixture = await createFixture();
  console.log(
    `fixture: ${fixture.root} — real git repo, ${TASK_COUNT} pending tasks, ` +
      `${EPISODE_COUNT} execution episodes, ${PLAN_REVISIONS} plan revisions; ` +
      'all state files pass the app\'s own compiled ajv validators',
  );

  try {
    const fileSystem = createNodeFileSystem();
    const redaction = createRedactor();
    /*
     * 预检读与采样读使用同一生产 Redactor 配置，确保新安全依赖没有被
     * 性能脚本遗漏，也不以 identity 替身低估真实读写成本。
     */
    const store = createJsonStateStore({
      stateDir: fixture.stateDir,
      fs: fileSystem,
      redaction,
    });

    // Pre-flight gates (before any sampling): one real consistent read and one
    // real CLI `status` must succeed on the fixture.
    const preflightSnapshot = await store.readConsistentSnapshot();
    if (preflightSnapshot === null || preflightSnapshot.run.runId !== fixture.runId) {
      throw new Error('pre-flight readConsistentSnapshot() did not return the fixture run');
    }
    const preflightCli = await runStatusCli(fixture.root);
    if (preflightCli.code !== 0) {
      throw new Error(
        `pre-flight status CLI failed with exit ${preflightCli.code}: ${preflightCli.stderr}`,
      );
    }
    console.log('pre-flight: readConsistentSnapshot() OK, status CLI exit 0 OK');

    const results = {};

    // Metric 1 — 本地 Task 选择: pure selectReadyTask, exactly as execute-next-task.ts calls it.
    const planTasks = preflightSnapshot.tasks.tasks;
    const taskStates = preflightSnapshot.run.tasks;
    results[METRICS[0].key] = await measureMetric(
      METRICS[0],
      () => {
        const selected = selectReadyTask('running', planTasks, taskStates);
        if (selected !== 'TASK-001') {
          throw new Error(`task-selection returned ${selected}, expected TASK-001`);
        }
      },
      options,
    );
    console.log(`[1/4] ${METRICS[0].key} sampled`);

    // Metric 2 — 本地状态读取: real readConsistentSnapshot() over the fixture state dir.
    results[METRICS[1].key] = await measureMetric(
      METRICS[1],
      async () => {
        const snapshot = await store.readConsistentSnapshot();
        if (snapshot === null || snapshot.run.runId !== fixture.runId) {
          throw new Error('state-read returned an unexpected snapshot');
        }
      },
      options,
    );
    console.log(`[2/4] ${METRICS[1].key} sampled`);

    // Metric 3 — status (CLI): whole spawned process wall time (includes Node boot).
    results[METRICS[2].key] = await measureMetric(
      METRICS[2],
      async () => {
        const result = await runStatusCli(fixture.root);
        if (result.code !== 0) {
          throw new Error(`status CLI exited ${result.code}: ${result.stderr.slice(0, 500)}`);
        }
      },
      options,
    );
    console.log(`[3/4] ${METRICS[2].key} sampled`);

    // Metric 4 — 启动检查(不含 Claude/Git): real StartRun with fake ports; the
    // non-terminal fixture run makes execute() fail deterministically with
    // RUN_ALREADY_ACTIVE_OR_INTERRUPTED after all local startup checks. The
    // path must be read-only: the whole fixture tree is hash-compared.
    const treeBefore = await hashFixtureTree(fixture.root);
    const startRun = createMetric4StartRun(fixture, fileSystem);
    const startInput = {
      cwd: fixture.rootSlash,
      specPath: null,
      fullAccess: false,
      claudeCliPath: null,
      gitCliPath: null,
      verbose: false,
      environment: {
        platform: process.platform,
        release: os.release(),
        nodeVersion: process.version,
        agentVersion: 'nfr007-performance-harness',
      },
    };
    results[METRICS[3].key] = await measureMetric(
      METRICS[3],
      async () => {
        const result = await startRun.execute(startInput);
        if (
          result.kind !== 'startup-failed' ||
          result.error.errorCode !== 'RUN_ALREADY_ACTIVE_OR_INTERRUPTED'
        ) {
          throw new Error(
            `startup-checks expected startup-failed/RUN_ALREADY_ACTIVE_OR_INTERRUPTED, got ${JSON.stringify(
              result.kind === 'startup-failed' ? result.error.errorCode : result.kind,
            )}`,
          );
        }
      },
      options,
    );
    assertTreeUnchanged(treeBefore, await hashFixtureTree(fixture.root));
    console.log(`[4/4] ${METRICS[3].key} sampled (fixture verified read-only across iterations)`);

    // Per-metric summary.
    console.log('\nper-metric summary (ms):');
    let allPass = true;
    for (const definition of METRICS) {
      const result = results[definition.key];
      allPass = allPass && result.pass;
      console.log(
        `  ${definition.key.padEnd(16)} min ${formatMs(result.min)}  median ${formatMs(
          result.median,
        )}  P95 ${formatMs(result.p95)}  max ${formatMs(result.max)}  ` +
          `threshold < ${String(definition.thresholdMs).padStart(4)} ms  ${
            result.pass ? 'PASS' : 'FAIL'
          }  — ${definition.description}`,
      );
    }

    if (options.out !== undefined) {
      const outPath = path.resolve(options.out);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      const report = { label: options.label, ...machine, metrics: results };
      await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\nreport written: ${outPath}`);
    }

    console.log(`\nNFR-007 harness result: ${allPass ? 'PASS' : 'FAIL'}`);
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[perf-nfr007] harness error: ${error instanceof Error ? error.message : error}`);
  if (error instanceof Error && error.stack !== undefined) console.error(error.stack);
  process.exitCode = 2;
});

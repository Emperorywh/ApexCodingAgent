/**
 * G6 CLI 进程级测试（SPEC §17 退出码矩阵、§2.4 中断、§16 风险提示、
 * DoD help 一致性）：以真实子进程跑 bin 入口产物（dist/interfaces/cli/
 * main.js），配临时 Git 仓库与可编程 Fake Claude。
 *
 * 信号用例说明：Windows 无法以纯 Node 向子进程投递可处理的 SIGINT
 * （process.kill 是无条件终止），故经 `--import` 注入
 * sigint-scheduler.mjs，在子进程内直接调用已注册的 SIGINT 监听——
 * 与真实 Ctrl+C 触发的是同一函数，后续有界收尾与退出码全走生产路径。
 * 第二次信号的"立即退出"分支另由 signals.test.ts 单元测试精确覆盖。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPLETE_HELP, FAKE_VERSION } from '../../integration/claude/helpers.js';
import { createTempRepo, seedRepo, type TempRepo } from '../../integration/git/helpers.js';
import {
  executionCompleted,
  finalReviewCompleted,
  planDraft,
  streamOf,
  type SequenceScenario,
} from '../../e2e/helpers.js';
import {
  awaitOutcome,
  createFakeClaudeEnv,
  ensureCliBuilt,
  FAKE_CLAUDE_PATH,
  SIGINT_SCHEDULER_URL,
  spawnCli,
  type FakeClaudeEnv,
} from './helpers.js';
import type { RunJson } from '../../../src/domain/schemas/run-json.js';

const HAPPY_SEQUENCE: SequenceScenario = {
  version: FAKE_VERSION,
  help: COMPLETE_HELP,
  sequence: [
    { stdoutLines: streamOf(planDraft([{ id: 'TASK-001', title: '实现功能 A' }])) },
    {
      writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
      stdoutLines: streamOf(executionCompleted()),
    },
    { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
  ],
};

const SLEEPING_PLANNING: SequenceScenario = {
  version: FAKE_VERSION,
  help: COMPLETE_HELP,
  sequence: [{ sleepMs: 300_000, stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) }],
};

interface Fixture {
  readonly repo: TempRepo;
  readonly fake: FakeClaudeEnv;
  readonly stateDir: string;
}

async function createFixture(): Promise<Fixture> {
  const repo = await createTempRepo();
  const fake = await createFakeClaudeEnv();
  return { repo, fake, stateDir: join(repo.root, '.apex-coding-agent') };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.repo.cleanup();
  await fixture.fake.cleanup();
}

async function readRunJson(stateDir: string): Promise<RunJson> {
  return JSON.parse(await readFile(join(stateDir, 'run.json'), 'utf8')) as RunJson;
}

/** 轮询直至 run.json 出现非空 activeSession（前台 Session 已接力）。 */
async function waitForActiveSession(stateDir: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const run = await readRunJson(stateDir);
      if (run.activeSession !== null) return;
    } catch {
      // run.json 尚未创建
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for activeSession in run.json');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('cli process: help & usage (§17)', () => {
  it('--help exits 0 and matches the documented text', async () => {
    ensureCliBuilt();
    const outcome = await awaitOutcome(spawnCli(['--help'], { cwd: process.cwd() }), 15_000);
    expect(outcome.code).toBe(0);
    // §17 命令形式逐字一致（DoD：CLI 帮助、默认值和本文一致）
    expect(outcome.stdout).toContain('ApexCodingAgent start [spec-path] [--full-access]');
    expect(outcome.stdout).toContain('[--claude-cli-path <path>] [--git-cli-path <path>]');
    expect(outcome.stdout).toContain('ApexCodingAgent status');
    expect(outcome.stdout).toContain('ApexCodingAgent report');
    expect(outcome.stdout).toContain('ApexCodingAgent abandon --force');
    // 默认值（§16）：auto 默认、planning 恒 plan、中断等待 10 秒
    expect(outcome.stdout).toContain('默认 auto');
    expect(outcome.stdout).toContain('10 秒');
    // 本版本不提供的命令不得出现在帮助中
    expect(outcome.stdout).not.toContain('pause');
    expect(outcome.stdout).not.toContain('stop');
    expect(outcome.stdout).toMatchSnapshot();
  }, 30_000);

  it('usage errors exit 2 with CLI_USAGE_INVALID', async () => {
    ensureCliBuilt();
    const cases: readonly string[][] = [
      [],
      ['frobnicate'],
      ['resume', 'SPEC.md'],
      ['start', '--nope'],
      ['start', 'a', 'b'],
      ['status', 'extra'],
      ['report', '--force'],
      ['abandon', 'extra'],
    ];
    for (const args of cases) {
      const outcome = await awaitOutcome(spawnCli(args, { cwd: process.cwd() }), 15_000);
      expect(outcome.code, `argv: ${args.join(' ')}`).toBe(2);
      expect(outcome.stderr, `argv: ${args.join(' ')}`).toContain('CLI_USAGE_INVALID');
    }
  }, 120_000);
});

describe('cli process: start exit codes', () => {
  it('start happy path exits 0; status reads completed with 0; report regenerates with 0', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario(HAPPY_SEQUENCE);

      const started = await awaitOutcome(
        spawnCli(['start', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: fixture.fake.env,
        }),
        90_000,
      );
      expect(started.code).toBe(0);
      // 每次状态迁移一行进度摘要（§17 start 语义）
      expect(started.stdout).toContain('planning -> running');
      expect(started.stdout).toContain('final_review -> completed');
      // 会话阶段行；默认不把调试 JSON 行镜像到 stderr
      expect(started.stdout).toContain('planning started');
      expect(started.stderr).not.toContain('"event":"');

      const status = await awaitOutcome(
        spawnCli(['status'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(status.code).toBe(0);
      expect(status.stdout).toContain('Status: completed');
      expect(status.stdout).toContain('TASK-001');
      expect(status.stdout).toContain('completed');

      const report = await awaitOutcome(
        spawnCli(['report'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(report.code).toBe(0);
      expect(report.stdout).toContain('report written: report.md');
    } finally {
      await cleanupFixture(fixture);
    }
  }, 150_000);

  it('start --verbose mirrors debug JSON lines to stderr and keeps the file log', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario(HAPPY_SEQUENCE);

      const outcome = await awaitOutcome(
        spawnCli(['start', '--verbose', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: fixture.fake.env,
        }),
        90_000,
      );
      expect(outcome.code).toBe(0);
      // --verbose：调试 JSON 行镜像到 stderr（JSON Lines，含事件名）
      expect(outcome.stderr).toContain('"event":"run.created"');
      expect(outcome.stderr).toContain('"event":"session.invoke.start"');
      expect(outcome.stderr).toContain('"event":"session.invoke.end"');
      // 文件日志始终落盘
      const debugLog = await readFile(
        join(fixture.stateDir, 'logs', 'apex-debug.log'),
        'utf8',
      );
      expect(debugLog).toContain('"event":"run.created"');
      expect(debugLog).toContain('"event":"driver.run_completed"');
    } finally {
      await cleanupFixture(fixture);
    }
  }, 150_000);

  it('start with a failing Claude exits 1 with CLAUDE_EXIT_NONZERO', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario({
        version: FAKE_VERSION,
        help: COMPLETE_HELP,
        sequence: [{ exitCode: 1, stderrText: 'provider exploded' }],
      });

      const outcome = await awaitOutcome(
        spawnCli(['start', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: fixture.fake.env,
        }),
        60_000,
      );
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain('CLAUDE_EXIT_NONZERO');
      const run = await readRunJson(fixture.stateDir);
      expect(run.status).toBe('failed');

      // status 读取 failed Run 仍属成功读取（退出码 0，§17）
      const status = await awaitOutcome(
        spawnCli(['status'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(status.code).toBe(0);
      expect(status.stdout).toContain('Status: failed');
      expect(status.stdout).toContain('CLAUDE_EXIT_NONZERO');
    } finally {
      await cleanupFixture(fixture);
    }
  }, 120_000);

  it('startup validation failure exits 3 with the stable code and creates no run', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      // 仓库有提交但没有 SPEC.md → SPEC_NOT_FOUND（startup_validation）。
      await fixture.repo.writeFile('README.md', '# no spec here\n');
      await fixture.repo.commitAll('initial commit');
      await fixture.fake.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP });

      const outcome = await awaitOutcome(
        spawnCli(['start', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: fixture.fake.env,
        }),
        60_000,
      );
      expect(outcome.code).toBe(3);
      expect(outcome.stderr).toContain('SPEC_NOT_FOUND');
      // 未创建新 Run
      await expect(readRunJson(fixture.stateDir)).rejects.toThrow();
    } finally {
      await cleanupFixture(fixture);
    }
  }, 120_000);

  it('--full-access shows the bypassPermissions risk warning (§16)', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario(HAPPY_SEQUENCE);

      const outcome = await awaitOutcome(
        spawnCli(['start', '--full-access', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: fixture.fake.env,
        }),
        90_000,
      );
      expect(outcome.code).toBe(0);
      const combined = outcome.stdout + outcome.stderr;
      expect(combined).toContain('风险提示');
      expect(combined).toContain('bypassPermissions');
    } finally {
      await cleanupFixture(fixture);
    }
  }, 150_000);
});

describe('cli process: abandon flow after an interrupted run (§17, AC-027/028)', () => {
  it('status/report/abandon exit-code matrix over a non-terminal leftover run', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario(SLEEPING_PLANNING);

      // 模拟操作系统强制关闭：Planning 中途无条件终止前台进程，
      // 持久化状态保持非终态（§2.4 后半段的显式产品边界）。
      const started = spawnCli(['start', '--claude-cli-path', FAKE_CLAUDE_PATH], {
        cwd: fixture.repo.root,
        env: fixture.fake.env,
      });
      await waitForActiveSession(fixture.stateDir);
      started.child.kill();
      await started.outcome;

      const statusPlanning = await awaitOutcome(
        spawnCli(['status'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(statusPlanning.code).toBe(0);
      expect(statusPlanning.stdout).toContain('Status: planning');

      const earlyReport = await awaitOutcome(
        spawnCli(['report'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(earlyReport.code).toBe(4);
      expect(earlyReport.stderr).toContain('REPORT_NOT_AVAILABLE');

      const noForce = await awaitOutcome(
        spawnCli(['abandon'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(noForce.code).toBe(4);
      expect(noForce.stderr).toContain('ABANDON_REQUIRES_FORCE');

      const forced = await awaitOutcome(
        spawnCli(['abandon', '--force'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(forced.code).toBe(0);
      // §17 第 3 步：无法判断旧进程是否仍然存在的风险提示
      expect(forced.stdout + forced.stderr).toContain('系统无法判断');
      const abandoned = await readRunJson(fixture.stateDir);
      expect(abandoned.status).toBe('abandoned');
      expect(abandoned.lastError?.errorCode).toBe('RUN_ABANDONED_BY_USER');

      // status 读取 abandoned Run 仍属成功读取（退出码 0）
      const statusAbandoned = await awaitOutcome(
        spawnCli(['status'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(statusAbandoned.code).toBe(0);
      expect(statusAbandoned.stdout).toContain('Status: abandoned');

      const again = await awaitOutcome(
        spawnCli(['abandon', '--force'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(again.code).toBe(4);
      expect(again.stderr).toContain('RUN_NOT_ABANDONABLE');

      // 终态 Run 的 report 重生成成功且不改终态（FR-028）
      const report = await awaitOutcome(
        spawnCli(['report'], { cwd: fixture.repo.root, env: fixture.fake.env }),
        15_000,
      );
      expect(report.code).toBe(0);
      expect((await readRunJson(fixture.stateDir)).status).toBe('abandoned');
    } finally {
      await cleanupFixture(fixture);
    }
  }, 180_000);
});

describe('cli process: foreground interrupt signals (§2.4)', () => {
  it('first interrupt settles bounded and exits 130 with RUN_INTERRUPTED facts', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario(SLEEPING_PLANNING);

      const outcome = await awaitOutcome(
        spawnCli(['start', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: {
            ...fixture.fake.env,
            APEX_TEST_SIGINT_STATEDIR: fixture.stateDir,
          },
          imports: [SIGINT_SCHEDULER_URL],
        }),
        90_000,
      );
      expect(outcome.code).toBe(130);
      expect(outcome.stderr).toContain('RUN_INTERRUPTED');

      // §2.4 第 4–6 步事实：Run failed、清槽、失败 Session Record 已保存。
      const run = await readRunJson(fixture.stateDir);
      expect(run.status).toBe('failed');
      expect(run.lastError?.errorCode).toBe('RUN_INTERRUPTED');
      expect(run.activeSession).toBeNull();
      expect(run.terminalAt).not.toBeNull();
    } finally {
      await cleanupFixture(fixture);
    }
  }, 150_000);

  it('a second interrupt still ends the process promptly with 130', async () => {
    ensureCliBuilt();
    const fixture = await createFixture();
    try {
      await seedRepo(fixture.repo);
      await fixture.fake.writeScenario(SLEEPING_PLANNING);

      const began = Date.now();
      const outcome = await awaitOutcome(
        spawnCli(['start', '--claude-cli-path', FAKE_CLAUDE_PATH], {
          cwd: fixture.repo.root,
          env: {
            ...fixture.fake.env,
            APEX_TEST_SIGINT_STATEDIR: fixture.stateDir,
            APEX_TEST_SIGINT_SECOND_MS: '150',
          },
          imports: [SIGINT_SCHEDULER_URL],
        }),
        90_000,
      );
      expect(outcome.code).toBe(130);
      // 有界：远小于 Fake Claude 的 300 秒睡眠与任何无界等待
      expect(Date.now() - began).toBeLessThan(60_000);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 150_000);
});

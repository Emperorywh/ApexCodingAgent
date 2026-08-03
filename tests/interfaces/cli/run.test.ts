/**
 * runCli 退出码映射单元测试（SPEC §17 退出码表、§15.2、§2.4）。
 *
 * 进程级矩阵见 process.test.ts；这里用可替换的 CliRuntime 精确覆盖：
 * 0/1/2/3/4/130 全部分支、RUN_INTERRUPTED 对 1 的优先、第一次信号到
 * 中断控制器的接线，以及 mock 平台/版本的 ENVIRONMENT_UNSUPPORTED（§8.1）。
 */
import { describe, expect, it } from 'vitest';
import { createInterruptController } from '../../../src/application/interrupt.js';
import type { StartRunInput, StartRunResult } from '../../../src/application/usecases/start-run.js';
import type { ResumeRunInput } from '../../../src/application/usecases/resume-run.js';
import { createCliRuntime } from '../../../src/bootstrap/composition-root.js';
import { collectEnvironmentFacts } from '../../../src/bootstrap/environment.js';
import { ApexError } from '../../../src/domain/errors.js';
import type { ErrorRecord } from '../../../src/domain/schemas/error-record.js';
import type { RunJson } from '../../../src/domain/schemas/run-json.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import { CLI_EXIT, runCli } from '../../../src/interfaces/cli/run.js';
import type {
  CliRuntime,
  SignalHandlerSpec,
} from '../../../src/interfaces/cli/runtime.js';

function makeErrorRecord(code: ErrorRecord['errorCode']): ErrorRecord {
  return {
    errorCode: code,
    errorClass: code === 'RUN_INTERRUPTED' ? 'run_error' : 'claude_error',
    stage: 'test',
    message: `synthetic ${code}`,
    toolSummary: null,
    sessionId: null,
    taskId: null,
    at: '2026-01-01T00:00:00Z',
  };
}

function makeRunJson(overrides: Partial<RunJson> = {}): RunJson {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    runId: 'RUN-123e4567-e89b-42d3-a456-426614174000',
    status: 'planning',
    spec: { path: 'SPEC.md', sha256: 'a'.repeat(64) },
    planRevision: 0,
    tasksSha256: null,
    runSettings: {
      executionPermissionMode: 'auto',
      claudeCliPath: null,
      gitCliPath: null,
      pushRemote: 'origin',
    },
    repository: {
      root: '/repo',
      baseBranch: 'main',
      baseBranchRef: 'refs/heads/main',
      baseCommit: 'b'.repeat(40),
      runBranch: 'apex-coding-agent/RUN-123e4567-e89b-42d3-a456-426614174000',
      expectedHead: 'b'.repeat(40),
    },
    currentTaskId: null,
    activeSession: null,
    planCandidate: null,
    planReviewFeedback: null,
    tasks: {},
    intermediateCheckpoints: [],
    finalReviewEpisodes: [],
    lastError: null,
    finalCommit: null,
    reportPath: null,
    resumePoint: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    terminalAt: null,
    ...overrides,
  };
}

interface FakeRuntime {
  readonly runtime: CliRuntime;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly interrupt: ReturnType<typeof createInterruptController>;
  readonly installedSignals: SignalHandlerSpec[];
  readonly disposed: number[];
}

function makeRuntime(overrides: Partial<CliRuntime> = {}): FakeRuntime {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const interrupt = createInterruptController();
  const installedSignals: SignalHandlerSpec[] = [];
  const disposed: number[] = [];
  const runtime: CliRuntime = {
    cwd: '/repo',
    environment: {
      platform: 'win32',
      release: '10.0.22631',
      nodeVersion: 'v22.11.0',
      agentVersion: '0.0.0-test',
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    redaction: createRedactor(),
    interrupt,
    startRun: {
      execute: () => {
        throw new Error('startRun.execute not stubbed');
      },
    },
    resume: {
      execute: () => {
        throw new Error('resume.execute not stubbed');
      },
    },
    status: {
      execute: () => {
        throw new Error('status.execute not stubbed');
      },
    },
    report: {
      execute: () => {
        throw new Error('report.execute not stubbed');
      },
    },
    abandon: {
      execute: () => {
        throw new Error('abandon.execute not stubbed');
      },
    },
    installSignals: (spec) => {
      installedSignals.push(spec);
      return () => disposed.push(1);
    },
    ...overrides,
  };
  return { runtime, stdout, stderr, interrupt, installedSignals, disposed };
}

function stubStartRun(result: StartRunResult): CliRuntime['startRun'] {
  return { execute: async () => result };
}

describe('runCli exit codes (§17)', () => {
  it('help exits 0 and prints the documented command forms', async () => {
    const { runtime, stdout } = makeRuntime();
    const code = await runCli(['--help'], runtime);
    expect(code).toBe(CLI_EXIT.ok);
    expect(stdout.join('\n')).toContain('ApexCodingAgent start [spec-path] [--full-access]');
    expect(stdout.join('\n')).toContain('ApexCodingAgent abandon --force');
  });

  it('usage errors exit 2 with CLI_USAGE_INVALID and help on stderr', async () => {
    const { runtime, stderr } = makeRuntime();
    const code = await runCli(['frobnicate'], runtime);
    expect(code).toBe(CLI_EXIT.usage);
    expect(stderr.join('\n')).toContain('CLI_USAGE_INVALID');
  });

  it('resume completed exits 0 and passes --force/--full-access through', async () => {
    const run = makeRunJson({ status: 'completed', terminalAt: '2026-01-01T01:00:00Z' });
    let received: ResumeRunInput | null = null;
    const { runtime, stdout } = makeRuntime({
      resume: {
        execute: async (input: ResumeRunInput) => {
          received = input;
          return { kind: 'completed', run };
        },
      },
    });
    const code = await runCli(['resume', '--force', '--full-access'], runtime);
    expect(code).toBe(CLI_EXIT.ok);
    expect(received!.force).toBe(true);
    expect(received!.fullAccess).toBe(true);
    /*
     * 成功摘要由 RunDriver 在真实执行链中唯一输出。
     * CLI 命令层只映射退出码，避免同一 Run 完成信息打印两次。
     */
    expect(stdout).toEqual([]);
  });

  it('resume interrupted failure exits 130, resumable failure exits 1', async () => {
    const interruptedRun = makeRunJson({
      status: 'failed',
      terminalAt: '2026-01-01T01:00:00Z',
      lastError: makeErrorRecord('RUN_INTERRUPTED'),
    });
    const interrupted = makeRuntime({
      resume: { execute: async () => ({ kind: 'failed', run: interruptedRun }) },
    });
    expect(await runCli(['resume'], interrupted.runtime)).toBe(CLI_EXIT.interrupted);
    expect(interrupted.stderr.join('\n')).toContain('已中断 · RUN_INTERRUPTED');
    expect(interrupted.stderr.join('\n')).not.toContain('失败 · RUN_INTERRUPTED');

    const plainRun = makeRunJson({
      status: 'failed',
      terminalAt: '2026-01-01T01:00:00Z',
      lastError: makeErrorRecord('CLAUDE_EXIT_NONZERO'),
    });
    const plain = makeRuntime({
      resume: { execute: async () => ({ kind: 'failed', run: plainRun }) },
    });
    expect(await runCli(['resume'], plain.runtime)).toBe(CLI_EXIT.runFailed);
  });

  it('resume command failures exit 4, startup validation failures exit 3', async () => {
    const notResumable = makeRuntime({
      resume: {
        execute: async () => ({
          kind: 'command-failed',
          error: new ApexError({
            code: 'RUN_NOT_RESUMABLE',
            stage: 'resume',
            message: 'run is completed; nothing to resume',
          }),
        }),
      },
    });
    const code = await runCli(['resume'], notResumable.runtime);
    expect(code).toBe(CLI_EXIT.command);
    expect(notResumable.stderr.join('\n')).toContain('RUN_NOT_RESUMABLE');

    const settingsInvalid = makeRuntime({
      resume: {
        execute: async () => ({
          kind: 'command-failed',
          error: new ApexError({
            code: 'SETTINGS_INVALID',
            stage: 'resume',
            message: 'pass --full-access explicitly',
          }),
        }),
      },
    });
    expect(await runCli(['resume'], settingsInvalid.runtime)).toBe(CLI_EXIT.startup);
  });

  it('start completed exits 0', async () => {
    const run = makeRunJson({ status: 'completed', terminalAt: '2026-01-01T01:00:00Z' });
    const { runtime, stdout } = makeRuntime({
      startRun: stubStartRun({ kind: 'completed', run }),
    });
    const code = await runCli(['start'], runtime);
    expect(code).toBe(CLI_EXIT.ok);
    /*
     * 此处使用的是绕过 RunDriver 的 stub，因此 stdout 应为空。
     * 真实进程测试会覆盖 RunDriver 产生的唯一完成摘要。
     */
    expect(stdout).toEqual([]);
  });

  it('start run failed exits 1 and surfaces the stable error code', async () => {
    const run = makeRunJson({
      status: 'failed',
      terminalAt: '2026-01-01T01:00:00Z',
      lastError: makeErrorRecord('CLAUDE_EXIT_NONZERO'),
    });
    const { runtime, stderr } = makeRuntime({
      startRun: stubStartRun({ kind: 'failed', run }),
    });
    const code = await runCli(['start'], runtime);
    expect(code).toBe(CLI_EXIT.runFailed);
    expect(stderr.join('\n')).toContain('CLAUDE_EXIT_NONZERO');
  });

  it('RUN_INTERRUPTED failure exits 130, taking priority over 1', async () => {
    const run = makeRunJson({
      status: 'failed',
      terminalAt: '2026-01-01T01:00:00Z',
      lastError: makeErrorRecord('RUN_INTERRUPTED'),
    });
    const { runtime, stderr } = makeRuntime({
      startRun: stubStartRun({ kind: 'failed', run }),
    });
    const code = await runCli(['start'], runtime);
    expect(code).toBe(CLI_EXIT.interrupted);
    expect(stderr.join('\n')).toContain('已中断 · RUN_INTERRUPTED');
    expect(stderr.join('\n')).not.toContain('失败 · RUN_INTERRUPTED');
  });

  it('startup validation failure exits 3 with the stable code', async () => {
    const error = new ApexError({
      code: 'SPEC_NOT_FOUND',
      stage: 'spec-discovery',
      message: 'no SPEC.md found',
    });
    const { runtime, stderr } = makeRuntime({
      startRun: stubStartRun({ kind: 'startup-failed', error }),
    });
    const code = await runCli(['start'], runtime);
    expect(code).toBe(CLI_EXIT.startup);
    expect(stderr.join('\n')).toContain('SPEC_NOT_FOUND');
  });

  it('start 把 --verbose 与 --push-remote 透传进 StartRunInput', async () => {
    const run = makeRunJson({ status: 'completed', terminalAt: '2026-01-01T01:00:00Z' });
    let received: StartRunInput | null = null;
    const { runtime } = makeRuntime({
      startRun: {
        execute: async (input: StartRunInput) => {
          received = input;
          return { kind: 'completed', run };
        },
      },
    });
    const code = await runCli(['start', '--verbose', '--push-remote', 'upstream'], runtime);
    expect(code).toBe(CLI_EXIT.ok);
    expect(received!.verbose).toBe(true);
    expect(received!.pushRemote).toBe('upstream');

    const quiet = makeRuntime({
      startRun: {
        execute: async (input: StartRunInput) => {
          received = input;
          return { kind: 'completed', run };
        },
      },
    });
    expect(await runCli(['start'], quiet.runtime)).toBe(CLI_EXIT.ok);
    expect(received!.verbose).toBe(false);
    expect(received!.pushRemote).toBeNull();
  });

  it('start wires the first interrupt signal to the interrupt controller', async () => {    const run = makeRunJson({
      status: 'failed',
      terminalAt: '2026-01-01T01:00:00Z',
      lastError: makeErrorRecord('RUN_INTERRUPTED'),
    });
    const fake = makeRuntime({ startRun: stubStartRun({ kind: 'failed', run }) });
    const code = await runCli(['start'], fake.runtime);
    expect(code).toBe(CLI_EXIT.interrupted);
    expect(fake.installedSignals).toHaveLength(1);
    fake.installedSignals[0]!.onFirstInterrupt();
    expect(fake.interrupt.requested).toBe(true);
    expect(fake.disposed).toHaveLength(1); // 信号处理随 start 结束解除
  });

  it('status without run.json exits 4 with RUN_NOT_FOUND', async () => {
    const { runtime, stderr } = makeRuntime({
      status: { execute: async () => null },
    });
    const code = await runCli(['status'], runtime);
    expect(code).toBe(CLI_EXIT.command);
    expect(stderr.join('\n')).toContain('RUN_NOT_FOUND');
  });

  it('status keeps STATE_SNAPSHOT_BUSY stable (AC-029)', async () => {
    const { runtime, stderr } = makeRuntime({
      status: {
        execute: async () => {
          throw new ApexError({ code: 'STATE_SNAPSHOT_BUSY', stage: 'state', message: 'busy' });
        },
      },
    });
    const code = await runCli(['status'], runtime);
    expect(code).toBe(CLI_EXIT.command);
    expect(stderr.join('\n')).toContain('STATE_SNAPSHOT_BUSY');
  });

  it('status maps corrupt state to COMMAND_STATE_INVALID', async () => {
    const { runtime, stderr } = makeRuntime({
      status: {
        execute: async () => {
          throw new ApexError({
            code: 'STATE_VALIDATION_FAILED',
            stage: 'state',
            message: 'bad json',
          });
        },
      },
    });
    const code = await runCli(['status'], runtime);
    expect(code).toBe(CLI_EXIT.command);
    expect(stderr.join('\n')).toContain('COMMAND_STATE_INVALID');
  });

  it('report on a non-terminal run exits 4 with REPORT_NOT_AVAILABLE', async () => {
    const { runtime, stderr } = makeRuntime({
      report: {
        execute: async () => {
          throw new ApexError({
            code: 'REPORT_NOT_AVAILABLE',
            stage: 'report',
            message: 'run is not terminal',
          });
        },
      },
    });
    const code = await runCli(['report'], runtime);
    expect(code).toBe(CLI_EXIT.command);
    expect(stderr.join('\n')).toContain('REPORT_NOT_AVAILABLE');
  });

  it('abandon without --force exits 4 with ABANDON_REQUIRES_FORCE', async () => {
    const { runtime, stderr } = makeRuntime({
      abandon: {
        execute: async () => {
          throw new ApexError({
            code: 'ABANDON_REQUIRES_FORCE',
            stage: 'abandon',
            message: 'explicit force required',
          });
        },
      },
    });
    const code = await runCli(['abandon'], runtime);
    expect(code).toBe(CLI_EXIT.command);
    expect(stderr.join('\n')).toContain('ABANDON_REQUIRES_FORCE');
  });

  /**
   * 查询命令必须把适配器错误收敛为 command_error。
   *
   * 这组断言保护 §15.2 的行为边界：只读/控制命令失败不能对外表达
   * git_error 或 startup_validation 所代表的 Run 状态迁移语义。
   */
  it('normalizes non-command adapter errors at each command boundary', async () => {
    const gitError = new ApexError({
      code: 'GIT_COMMAND_FAILED',
      stage: 'git',
      message: 'git process failed',
    });
    const status = makeRuntime({
      status: {
        execute: async () => {
          throw gitError;
        },
      },
    });
    expect(await runCli(['status'], status.runtime)).toBe(CLI_EXIT.command);
    expect(status.stderr.join('\n')).toContain('COMMAND_STATE_INVALID');
    expect(status.stderr.join('\n')).not.toContain('error GIT_COMMAND_FAILED');

    const report = makeRuntime({
      report: {
        execute: async () => {
          throw gitError;
        },
      },
    });
    expect(await runCli(['report'], report.runtime)).toBe(CLI_EXIT.command);
    expect(report.stderr.join('\n')).toContain('REPORT_COMMAND_FAILED');

    const abandon = makeRuntime({
      abandon: {
        execute: async () => {
          throw gitError;
        },
      },
    });
    expect(await runCli(['abandon', '--force'], abandon.runtime)).toBe(CLI_EXIT.command);
    expect(abandon.stderr.join('\n')).toContain('COMMAND_STATE_INVALID');
  });
});

describe('environment gate (§8.1 items 1/3, mocked facts)', () => {
  async function expectUnsupported(environment: {
    platform: string;
    release: string;
    nodeVersion: string;
  }): Promise<string[]> {
    const stderr: string[] = [];
    const runtime = createCliRuntime({
      cwd: '/nonexistent',
      environment: collectEnvironmentFacts(environment),
      stdout: () => {},
      stderr: (text) => stderr.push(text),
    });
    const code = await runCli(['start'], runtime);
    expect(code).toBe(CLI_EXIT.startup);
    return stderr;
  }

  it('rejects non-Windows platforms with ENVIRONMENT_UNSUPPORTED', async () => {
    const stderr = await expectUnsupported({
      platform: 'linux',
      release: '6.5.0',
      nodeVersion: 'v22.11.0',
    });
    expect(stderr.join('\n')).toContain('ENVIRONMENT_UNSUPPORTED');
  });

  it('rejects Windows versions below 10', async () => {
    const stderr = await expectUnsupported({
      platform: 'win32',
      release: '6.3.9600',
      nodeVersion: 'v22.11.0',
    });
    expect(stderr.join('\n')).toContain('ENVIRONMENT_UNSUPPORTED');
  });

  it('rejects Node major versions other than 22/24', async () => {
    const stderr = await expectUnsupported({
      platform: 'win32',
      release: '10.0.22631',
      nodeVersion: 'v20.18.0',
    });
    expect(stderr.join('\n')).toContain('ENVIRONMENT_UNSUPPORTED');
  });
});

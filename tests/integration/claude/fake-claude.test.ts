/**
 * Fake Claude 进程级集成测试。真实适配器驱动可编程假 CLI，覆盖参数数组、
 * 环境继承、Session 日志脱敏、Session 类型与结果矩阵、中断、启动失败
 * 以及能力探测。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeRuntime } from '../../../src/adapters/claude/client.js';
import { createNodeFileSystem } from '../../../src/adapters/filesystem/node-file-system.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import {
  ClaudeInvocationError,
  type ClaudeRuntimePort,
} from '../../../src/application/ports/ClaudeRuntimePort.js';
import type { FileSystemPort } from '../../../src/application/ports/file-system.js';
import type { SessionType } from '../../../src/domain/schemas/active-session.js';
import type { ErrorCode } from '../../../src/domain/errors.js';
import { getSchemaJson } from '../../../src/domain/schemas/index.js';
import type { TaskPlanDraft } from '../../../src/domain/schemas/task-plan-draft.js';
import { expectApexErrorAsync } from '../../adapters/fixtures.js';
import {
  activateHarness,
  COMPLETE_HELP,
  createFakeClaudeHarness,
  FAKE_CLAUDE_PATH,
  FAKE_VERSION,
  makeRuntime,
  mkRequest,
  scenarioFor,
  SESSION_ID,
  streamLines,
  type FakeClaudeHarness,
} from './helpers.js';

const TEST_TIMEOUT = { timeout: 30_000 };

let harness: FakeClaudeHarness;
let restoreHarnessEnv: () => void;
let runtime: ClaudeRuntimePort;

beforeEach(async () => {
  harness = await createFakeClaudeHarness();
  restoreHarnessEnv = activateHarness(harness);
  runtime = makeRuntime();
});

afterEach(async () => {
  restoreHarnessEnv();
  delete process.env['APEX_G4_VISIBLE'];
  delete process.env['APEX_G4_TOKEN'];
  delete process.env['ANTHROPIC_BASE_URL'];
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  await harness.cleanup();
});

describe('argument array contract (SPEC §7.2)', () => {
  it('passes the exact argv array, including a shell-hostile prompt, without shell interpolation', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('execution') });
    const prompt = 'Implement "A" & <B> | %PATH% $HOME `tick` ; rm -rf /';
    const fact = await runtime.invoke(mkRequest(harness, { prompt }));
    expect(fact.exitCode).toBe(0);

    const records = await harness.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.argv).toEqual([
      '-p',
      '--session-id',
      SESSION_ID,
      '--permission-mode',
      'auto',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(getSchemaJson('TaskExecutionResult')),
      prompt,
    ]);
    expect(records[0]!.cwd).toBe(harness.root);
  }, TEST_TIMEOUT);

  it('returns the full success fact and writes the session log', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution', { provider: 'fake-provider' }),
    });
    const fact = await runtime.invoke(mkRequest(harness));
    expect(fact).toEqual({
      sessionId: SESSION_ID,
      type: 'execution',
      exitCode: 0,
      structuredResult: expect.objectContaining({ decision: 'completed' }),
      claudeVersion: FAKE_VERSION,
      model: 'claude-fake-model',
      provider: 'fake-provider',
      stderrSummary: null,
      logPath: `logs/${SESSION_ID}.log`,
    });

    const log = await harness.readSessionLog(SESSION_ID);
    expect(log).toContain('"type":"result"');
    expect(log).toContain(SESSION_ID);
  }, TEST_TIMEOUT);

  it('preserves a redacted stderr diagnosis even when the session succeeds', async () => {
    const token = 'sk-ant-abcdef1234567890ABCDEF_xyz';
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution'),
      stderrText: `warning Authorization: Bearer ${token}`,
    });

    const fact = await runtime.invoke(mkRequest(harness));
    expect(fact.stderrSummary).toContain('[REDACTED]');
    expect(fact.stderrSummary).not.toContain(token);
    const log = await harness.readSessionLog(SESSION_ID);
    expect(log).toContain('[apex stderr diagnostic]');
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain(token);
  }, TEST_TIMEOUT);

  it('forwards bypassPermissions verbatim when the caller requests full access', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('execution') });
    await runtime.invoke(mkRequest(harness, { permissionMode: 'bypassPermissions' }));
    const records = await harness.readRecords();
    expect(records[0]!.argv).toContain('bypassPermissions');
  }, TEST_TIMEOUT);

  it('builds the resume invocation with --resume, --fork-session and the new session id', async () => {
    const resumedFrom = '123e4567-e89b-42d3-a456-426614174999';
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('execution') });
    const fact = await runtime.invoke(mkRequest(harness, { resumeFromSessionId: resumedFrom }));
    expect(fact.exitCode).toBe(0);
    expect(fact.sessionId).toBe(SESSION_ID);

    const records = await harness.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.argv).toEqual([
      '-p',
      '--resume',
      resumedFrom,
      '--fork-session',
      '--session-id',
      SESSION_ID,
      '--permission-mode',
      'auto',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(getSchemaJson('TaskExecutionResult')),
      'Implement the task',
    ]);
  }, TEST_TIMEOUT);

  it('maps an explicit missing transcript diagnosis to CLAUDE_RESUME_UNAVAILABLE', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      exitCode: 1,
      stderrText: 'No conversation found with session ID: missing',
    });
    const error = await expectApexErrorAsync(
      () =>
        runtime.invoke(
          mkRequest(harness, {
            resumeFromSessionId: '123e4567-e89b-42d3-a456-426614174999',
          }),
        ),
      'CLAUDE_RESUME_UNAVAILABLE',
    );
    expect(error).toBeInstanceOf(ClaudeInvocationError);
    expect((error as ClaudeInvocationError).processExitCode).toBe(1);
  }, TEST_TIMEOUT);

  it('does not classify ordinary resume failures as transcript unavailable', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      exitCode: 1,
      stderrText: 'authentication failed: quota unavailable',
    });
    await expectApexErrorAsync(
      () =>
        runtime.invoke(
          mkRequest(harness, {
            resumeFromSessionId: '123e4567-e89b-42d3-a456-426614174999',
          }),
        ),
      'CLAUDE_EXIT_NONZERO',
    );
  }, TEST_TIMEOUT);

  it('does not fall back after the resumed process has emitted any stream event', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: [
        {
          type: 'system',
          subtype: 'init',
          session_id: SESSION_ID,
          model: 'fake-model',
        },
      ],
      exitCode: 1,
      stderrText: 'No conversation found for session ID after partial execution',
    });
    /**
     * 即使 stderr 含 transcript 关键词，只要 stdout 已产生事件，就不能
     * 假定会话尚未执行；适配器必须保留普通非零退出语义，禁止自动重试。
     */
    await expectApexErrorAsync(
      () =>
        runtime.invoke(
          mkRequest(harness, {
            resumeFromSessionId: '123e4567-e89b-42d3-a456-426614174999',
          }),
        ),
      'CLAUDE_EXIT_NONZERO',
    );
  }, TEST_TIMEOUT);
});

describe('session type × outcome matrix (SPEC §22.2)', () => {
  const cases: readonly { sessionType: SessionType; outcome: 'success' | 'schema-error' | 'nonzero-exit'; expectedCode?: ErrorCode }[] = [
    { sessionType: 'planning', outcome: 'success' },
    { sessionType: 'planning', outcome: 'schema-error', expectedCode: 'CLAUDE_RESULT_INVALID' },
    { sessionType: 'planning', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
    { sessionType: 'execution', outcome: 'success' },
    { sessionType: 'execution', outcome: 'schema-error', expectedCode: 'CLAUDE_RESULT_INVALID' },
    { sessionType: 'execution', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
    { sessionType: 'final_review', outcome: 'success' },
    { sessionType: 'final_review', outcome: 'schema-error', expectedCode: 'FINAL_REVIEW_RESULT_INVALID' },
    { sessionType: 'final_review', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
  ];

  for (const { sessionType, outcome, expectedCode } of cases) {
    it(`${sessionType} / ${outcome}`, async () => {
      await harness.writeScenario(scenarioFor(sessionType, outcome));
      const request = mkRequest(harness, {
        type: sessionType,
        permissionMode: sessionType === 'planning' ? 'plan' : 'auto',
      });

      if (expectedCode === undefined) {
        const fact = await runtime.invoke(request);
        expect(fact.exitCode).toBe(0);
        expect(fact.claudeVersion).toBe(FAKE_VERSION);
        if (sessionType === 'planning') {
          expect((fact.structuredResult as TaskPlanDraft).tasks[0]?.id).toBe('TASK-001');
        } else {
          expect(
            (fact.structuredResult as { readonly decision: string }).decision,
          ).toBe('completed');
        }
        const records = await harness.readRecords();
        const modeIndex = records[0]!.argv.indexOf('--permission-mode');
        expect(records[0]!.argv[modeIndex + 1]).toBe(
          sessionType === 'planning' ? 'plan' : 'auto',
        );
        return;
      }

      const error = await expectApexErrorAsync(() => runtime.invoke(request), expectedCode);
      expect(error).toBeInstanceOf(ClaudeInvocationError);
      const invocationError = error as ClaudeInvocationError;
      if (expectedCode === 'CLAUDE_EXIT_NONZERO') {
        expect(invocationError.processExitCode).toBe(3);
        expect(invocationError.toolSummary).toContain('out of quota');
      } else {
        expect(invocationError.processExitCode).toBe(0);
      }
      expect(invocationError.claudeVersion).toBe(FAKE_VERSION);
      // 即使 Session 失败，已经采集并脱敏的日志仍必须保留。
      const log = await harness.readSessionLog(SESSION_ID);
      expect(log).toContain('"type":"system"');
    }, TEST_TIMEOUT);
  }
});

describe('business decisions are not adapter errors (SPEC §9.6)', () => {
  it('decision failed and replan_required come back as successful invocation facts', async () => {
    const failedResult = {
      decision: 'failed',
      summary: 'Could not finish',
      tests: [{ command: 'npm test', result: 'failed' }],
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'not_satisfied', evidence: 'still red' },
      ],
      changedAreas: [],
      remainingRisks: ['broken build'],
      replanReason: null,
    };
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution', { structuredOutput: failedResult }),
    });
    const failedFact = await runtime.invoke(mkRequest(harness));
    expect((failedFact.structuredResult as { readonly decision: string }).decision).toBe('failed');

    const replanResult = { ...failedResult, decision: 'replan_required', replanReason: 'wrong approach' };
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution', { structuredOutput: replanResult }),
    });
    const replanFact = await runtime.invoke(mkRequest(harness));
    expect((replanFact.structuredResult as { readonly decision: string }).decision).toBe(
      'replan_required',
    );
  }, TEST_TIMEOUT);
});

describe('environment inheritance and redaction (SPEC §10.2, §18.4)', () => {
  it('the child sees the inherited user environment', async () => {
    process.env['APEX_G4_VISIBLE'] = 'visible-value-123';
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution'),
      printEnv: ['APEX_G4_VISIBLE'],
      recordEnv: ['APEX_G4_VISIBLE'],
    });
    await runtime.invoke(mkRequest(harness));

    const records = await harness.readRecords();
    expect(records[0]!.env['APEX_G4_VISIBLE']).toBe('visible-value-123');
    const log = await harness.readSessionLog(SESSION_ID);
    expect(log).toContain('visible-value-123');
  }, TEST_TIMEOUT);

  it('a secret echoed by claude is redacted in the session log', async () => {
    const token = 'sk-ant-abcdef1234567890ABCDEF_xyz';
    process.env['APEX_G4_TOKEN'] = token;
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution'),
      printEnv: ['APEX_G4_TOKEN'],
    });
    const fact = await runtime.invoke(mkRequest(harness));
    expect(fact.exitCode).toBe(0);

    const log = await harness.readSessionLog(SESSION_ID);
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain(token);
    // Fake CLI 的记录文件也不得出现该凭据。
    const rawRecords = await readFile(harness.recordPath, 'utf8');
    expect(rawRecords).not.toContain(token);
  }, TEST_TIMEOUT);

  it('CC Switch style: environment-only provider configuration works without any private API', async () => {
    const token = 'sk-ant-abcdef1234567890ABCDEF_xyz';
    process.env['ANTHROPIC_BASE_URL'] = 'https://proxy.example.invalid/anthropic';
    process.env['ANTHROPIC_AUTH_TOKEN'] = token;
    await harness.writeScenario({
      version: FAKE_VERSION,
      // 流中不提供 provider，验证适配器不会从环境变量反向推导元数据。
      stdoutLines: streamLines('execution', { provider: null }),
      printEnv: ['ANTHROPIC_AUTH_TOKEN'],
      recordEnv: ['ANTHROPIC_BASE_URL'],
    });
    const fact = await runtime.invoke(mkRequest(harness));

    expect(fact.exitCode).toBe(0);
    expect(fact.provider).toBeNull();
    // 子进程仍可看到 Provider 环境，这是 CC Switch 集成所需的唯一通道。
    const records = await harness.readRecords();
    expect(records[0]!.env['ANTHROPIC_BASE_URL']).toBe(
      'https://proxy.example.invalid/anthropic',
    );
    // 敏感 Token 不得进入持久化日志。
    const log = await harness.readSessionLog(SESSION_ID);
    expect(log).not.toContain(token);
  }, TEST_TIMEOUT);
});

describe('failure handling (SPEC §9.6)', () => {
  it('abort() kills the in-flight session within the bounded wait', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution'),
      sleepMs: 60_000,
    });
    const started = Date.now();
    const pending = runtime.invoke(mkRequest(harness));
    /**
     * invoke 在返回 Promise 前已经同步创建并登记唯一直接子进程，因此
     * 立即 abort 也必须命中该进程，不能存在版本探测后的二次启动窗口。
     */
    runtime.abort();
    await expectApexErrorAsync(() => pending, 'CLAUDE_EXIT_NONZERO');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, TEST_TIMEOUT);

  it('a missing executable maps to CLAUDE_START_FAILED with a null process exit code', async () => {
    const broken = makeRuntime({ claudePath: join(harness.root, 'no-such-claude.exe') });
    const error = await expectApexErrorAsync(
      () => broken.invoke(mkRequest(harness)),
      'CLAUDE_START_FAILED',
    );
    const invocationError = error as ClaudeInvocationError;
    expect(invocationError.processExitCode).toBeNull();
    expect(invocationError.claudeVersion).toBe(FAKE_VERSION);
  }, TEST_TIMEOUT);

  it('maps a synchronous spawn argument failure to CLAUDE_START_FAILED', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('execution') });
    const error = await expectApexErrorAsync(
      () => runtime.invoke(mkRequest(harness, { prompt: 'invalid\u0000prompt' })),
      'CLAUDE_START_FAILED',
    );
    expect(error).toBeInstanceOf(ClaudeInvocationError);
    expect((error as ClaudeInvocationError).processExitCode).toBeNull();
  }, TEST_TIMEOUT);

  it('a session log write failure maps to STATE_WRITE_FAILED', async () => {
    const base = createNodeFileSystem();
    const failingFileSystem: FileSystemPort = {
      ...base,
      async writeFile(path, data) {
        if (path.endsWith('.log')) throw new Error('simulated disk full');
        return base.writeFile(path, data);
      },
    };
    const failingRuntime = makeRuntime({ fileSystem: failingFileSystem });
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('execution') });
    const error = await expectApexErrorAsync(
      () => failingRuntime.invoke(mkRequest(harness)),
      'STATE_WRITE_FAILED',
    );
    expect((error as ClaudeInvocationError).processExitCode).toBe(0);
  }, TEST_TIMEOUT);
});

describe('capability probing through the CLI (SPEC §8.1)', () => {
  it('confirms a capable installation', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP });
    const report = await runtime.probeCapabilities();
    expect(report.version).toBe(FAKE_VERSION);
    expect(report.capabilities).toHaveLength(9);
  }, TEST_TIMEOUT);

  it('lists missing capabilities with the actual version', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      help: 'Usage: claude [options]\n  -p, --print   print response and exit\n',
    });
    const error = await expectApexErrorAsync(
      () => runtime.probeCapabilities(),
      'CLAUDE_CAPABILITY_MISSING',
    );
    expect(error.message).toContain('json-schema');
    expect(error.message).toContain(FAKE_VERSION);
  }, TEST_TIMEOUT);

  it('maps a CLI that cannot report its version to CLAUDE_INSTALLATION_UNHEALTHY', async () => {
    await harness.writeScenario({ version: 'broken', versionExitCode: 1 });
    await expectApexErrorAsync(
      () => runtime.probeCapabilities(),
      'CLAUDE_INSTALLATION_UNHEALTHY',
    );
  }, TEST_TIMEOUT);

  it('resolves the bare default command through a Windows shim on PATH', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP });
    await writeFile(join(harness.root, 'claude.cmd'), `"${FAKE_CLAUDE_PATH}"   %*\r\n`, 'utf8');
    const pathKey =
      Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const savedPath = process.env[pathKey];
    process.env[pathKey] = `${harness.root};${savedPath ?? ''}`;
    try {
      const shimmedRuntime = createClaudeRuntime({
        fileSystem: createNodeFileSystem(),
        redaction: createRedactor(),
        probeTimeoutMs: 15_000,
      });
      const report = await shimmedRuntime.probeCapabilities();
      expect(report.version).toBe(FAKE_VERSION);
      expect(report.capabilities).toHaveLength(9);
    } finally {
      if (savedPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = savedPath;
    }
  }, TEST_TIMEOUT);
});

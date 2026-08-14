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
import {
  getSchemaJson,
  getTaskPlanDraftSchemaJson,
} from '../../../src/domain/schemas/index.js';
import type { TaskPlanDraft } from '../../../src/domain/schemas/task-plan-draft.js';
import { expectApexErrorAsync } from '../../adapters/fixtures.js';
import {
  COMPLETE_HELP,
  createFakeClaudeHarness,
  fakeClaudeEnvironment,
  FAKE_CAPABILITY_REPORT,
  FAKE_CLAUDE_PATH,
  FAKE_VERSION,
  makeRuntime,
  mkRequest,
  scenarioFor,
  SESSION_ID,
  streamLines,
  validStructuredResult,
  type FakeClaudeHarness,
} from './helpers.js';
import { createTestProcessExecutor } from '../../process-executor.js';

const TEST_TIMEOUT = { timeout: 30_000 };

/**
 * Session 日志的公开契约是 JSONL；测试统一通过标准 JSON 解析器读取，
 * 避免字符串包含断言掩盖数字字段被文本替换后产生的损坏记录。
 */
function parseSessionLog(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('session log record must be a JSON object');
      }
      return value as Record<string, unknown>;
    });
}

let harness: FakeClaudeHarness;
let runtime: ClaudeRuntimePort;

beforeEach(async () => {
  harness = await createFakeClaudeHarness();
  runtime = makeRuntime(harness);
});

afterEach(async () => {
  /**
   * Provider 继承测试仍会显式修改父进程环境，因此只恢复这些用例自己的事实。
   * Fake CLI 场景已绑定到执行器实例，不再需要全局恢复步骤。
   */
  delete process.env['APEX_G4_VISIBLE'];
  delete process.env['APEX_G4_TOKEN'];
  delete process.env['ANTHROPIC_BASE_URL'];
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  await harness.cleanup();
});

describe('argument array contract (SPEC §7.2)', () => {
  it('passes control options in argv and transports the prompt through stdin', async () => {
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
    ]);
    expect(records[0]!.stdin).toBe(prompt);
    expect(records[0]!.cwd).toBe(harness.root);
  }, TEST_TIMEOUT);

  it('初始 Planning 向 Claude 传递不含 retain 分支的窄 Schema', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('planning') });
    await runtime.invoke(
      mkRequest(harness, {
        type: 'planning',
        permissionMode: 'plan',
        planningDraftSchemaMode: 'initial',
      }),
    );

    /**
     * 这里验证真实进程 argv，而不只验证领域 Schema 辅助函数，保证收紧契约
     * 确实到达 Claude Code 的 StructuredOutput 工具边界。
     */
    const records = await harness.readRecords();
    const schemaIndex = records[0]!.argv.indexOf('--json-schema');
    expect(records[0]!.argv[schemaIndex + 1]).toBe(
      JSON.stringify(getTaskPlanDraftSchemaJson('initial')),
    );
  }, TEST_TIMEOUT);

  it('初始 Planning 保留可解析的 retain 漂移，供应用层确定性恢复', async () => {
    const retainedDraft = {
      summary: '非法初始草稿',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [{ id: 'TASK-001', disposition: 'retain' }],
    };
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('planning', { structuredOutput: retainedDraft }),
    });

    const fact = await runtime.invoke(
      mkRequest(harness, {
        type: 'planning',
        permissionMode: 'plan',
        planningDraftSchemaMode: 'initial',
      }),
    );

    /**
     * 外发 Schema 已负责阻止正常的非法提交；若 CLI 仍返回通用 Schema 合法的
     * retain，Adapter 不抹掉该事实，由 GeneratePlanRevision 使用权威上一稿恢复。
     */
    expect(fact.structuredResult).toEqual(retainedDraft);
  }, TEST_TIMEOUT);

  it('passes the Task turn budget as an explicit Claude CLI option', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('execution') });
    const fact = await runtime.invoke(mkRequest(harness, { maxTurns: 64 }));
    expect(fact.exitCode).toBe(0);

    /**
     * Task 预算必须在进程边界转化为显式参数，避免预算只停留在计划文档中，
     * 却没有真正约束执行 Session 的最大代理轮次。
     */
    const records = await harness.readRecords();
    expect(records).toHaveLength(1);
    const optionIndex = records[0]!.argv.indexOf('--max-turns');
    expect(optionIndex).toBeGreaterThanOrEqual(0);
    expect(records[0]!.argv[optionIndex + 1]).toBe('64');
  }, TEST_TIMEOUT);

  it('starts a session when the prompt exceeds the Windows command-line limit', async () => {
    await harness.writeScenario({ version: FAKE_VERSION, stdoutLines: streamLines('final_review') });
    const prompt = `最终复核上下文\n${'验收证据与任务定义。'.repeat(8_192)}`;
    const fact = await runtime.invoke(
      mkRequest(harness, { type: 'final_review', prompt }),
    );

    /**
     * 回归输入显著超过 Windows CreateProcess 的命令行上限。
     *
     * 成功结果证明 prompt 未参与 argv 组装，同时 Fake CLI 收到的 stdin
     * 必须与原文本完全一致，不能通过截断来规避长度错误。
     */
    expect(prompt.length).toBeGreaterThan(32_767);
    expect(fact.exitCode).toBe(0);
    const records = await harness.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.argv).not.toContain(prompt);
    expect(records[0]!.stdin).toBe(prompt);
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
    expect(parseSessionLog(log)).toHaveLength(2);
  }, TEST_TIMEOUT);

  it('filters high-frequency thinking telemetry and keeps the session log valid JSONL', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: [
        {
          type: 'system',
          subtype: 'init',
          session_id: '{sessionId}',
          model: 'claude-fake-model',
        },
        {
          type: 'system',
          subtype: 'thinking_tokens',
          session_id: '{sessionId}',
          estimated_tokens: 123,
        },
        {
          type: 'system',
          subtype: 'thinking_tokens',
          session_id: '{sessionId}',
          estimated_tokens: 456,
        },
        {
          type: 'assistant',
          session_id: '{sessionId}',
          message: { content: [{ type: 'text', text: 'verification complete' }] },
          usage: { input_tokens: 789 },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: '{sessionId}',
          structured_output: validStructuredResult('execution'),
        },
      ],
    });

    const fact = await runtime.invoke(mkRequest(harness));
    expect(fact.exitCode).toBe(0);

    const records = parseSessionLog(await harness.readSessionLog(SESSION_ID));
    /*
     * 高频遥测不逐条持久化，只留下一个可观察的聚合摘要；普通事件仍保留，
     * 且敏感数字字段使用数字占位值，整份日志可被逐行 JSON.parse。
     */
    expect(
      records.some(
        (record) => record['type'] === 'system' && record['subtype'] === 'thinking_tokens',
      ),
    ).toBe(false);
    expect(records).toContainEqual({
      type: 'apex.log-summary',
      filteredEvents: [{ category: 'system/thinking', count: 2 }],
    });
    const assistant = records.find((record) => record['type'] === 'assistant');
    expect(assistant).toBeDefined();
    expect((assistant!['usage'] as Record<string, unknown>)['input_tokens']).toBe(0);
  }, TEST_TIMEOUT);

  it('persists stdout events before the Claude process exits', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: streamLines('execution'),
      sleepMs: 3_000,
    });
    const invocation = runtime.invoke(mkRequest(harness));
    let invocationSettled = false;
    void invocation.then(
      () => {
        invocationSettled = true;
      },
      () => {
        invocationSettled = true;
      },
    );

    let streamedLog: string | null = null;
    const observationDeadline = Date.now() + 15_000;
    while (Date.now() < observationDeadline && !invocationSettled) {
      try {
        const candidate = await harness.readSessionLog(SESSION_ID);
        if (candidate.includes('"type":"result"')) {
          streamedLog = candidate;
          break;
        }
      } catch {
        // 日志文件在首个 stdout 字节到达前尚未创建，短暂轮询属于预期状态。
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    /**
     * Fake Claude 在输出完整事件后继续存活三秒，观测循环则允许全量并发测试下的
     * 进程启动排队。只有在调用尚未结束时读到结果行，才能证明日志是增量落盘，
     * 而不是在子进程退出后一次性写入；最终结果仍需正常完成并通过结构校验。
     */
    expect(streamedLog).not.toBeNull();
    const fact = await invocation;
    expect(fact.exitCode).toBe(0);
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
    const records = parseSessionLog(log);
    expect(records.at(-1)?.['type']).toBe('apex.stderr-diagnostic');
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
    ]);
    expect(records[0]!.stdin).toBe('Implement the task');
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

  it('recognizes a resume diagnosis after long stderr without retaining the full text', async () => {
    await harness.writeScenario({
      version: FAKE_VERSION,
      exitCode: 1,
      stderrText:
        `${'ordinary diagnostic '.repeat(3_000)}\n` +
        'No conversation found with session ID: missing',
    });

    /**
     * 诊断位于有界错误摘要之外，仍应由滚动匹配器识别；这同时验证内存上限
     * 不会改变原有的 CLAUDE_RESUME_UNAVAILABLE 分类语义。
     */
    await expectApexErrorAsync(
      () =>
        runtime.invoke(
          mkRequest(harness, {
            resumeFromSessionId: '123e4567-e89b-42d3-a456-426614174999',
          }),
        ),
      'CLAUDE_RESUME_UNAVAILABLE',
    );
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
    { sessionType: 'plan_review', outcome: 'success' },
    { sessionType: 'plan_review', outcome: 'schema-error', expectedCode: 'PLAN_REVIEW_RESULT_INVALID' },
    { sessionType: 'plan_review', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
    { sessionType: 'execution', outcome: 'success' },
    { sessionType: 'execution', outcome: 'schema-error', expectedCode: 'CLAUDE_RESULT_INVALID' },
    { sessionType: 'execution', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
    { sessionType: 'task_review', outcome: 'success' },
    { sessionType: 'task_review', outcome: 'schema-error', expectedCode: 'TASK_REVIEW_RESULT_INVALID' },
    { sessionType: 'task_review', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
    { sessionType: 'final_review', outcome: 'success' },
    { sessionType: 'final_review', outcome: 'schema-error', expectedCode: 'FINAL_REVIEW_RESULT_INVALID' },
    { sessionType: 'final_review', outcome: 'nonzero-exit', expectedCode: 'CLAUDE_EXIT_NONZERO' },
  ];

  for (const { sessionType, outcome, expectedCode } of cases) {
    it(`${sessionType} / ${outcome}`, async () => {
      await harness.writeScenario(scenarioFor(sessionType, outcome));
      const request = mkRequest(harness, {
        type: sessionType,
        permissionMode:
          sessionType === 'planning' || sessionType === 'plan_review' ? 'plan' : 'auto',
        ...(sessionType === 'planning' ? { planningDraftSchemaMode: 'replan' as const } : {}),
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
          ).toBe(
            sessionType === 'task_review' || sessionType === 'plan_review'
              ? 'approved'
              : 'completed',
          );
        }
        const records = await harness.readRecords();
        const modeIndex = records[0]!.argv.indexOf('--permission-mode');
        expect(records[0]!.argv[modeIndex + 1]).toBe(
          sessionType === 'planning' || sessionType === 'plan_review' ? 'plan' : 'auto',
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

  it('normalizes ANSI sequences before redacting metadata and progress facts', async () => {
    /*
     * 版本与模型标识会进入调用事实、进度回调和 Session 日志；凭据被
     * ANSI 序列拆开时，三个出口都必须得到同一个安全值。
     */
    const secret = 'sk-proj-abcdefghijklmnop';
    const disguised = 'sk-proj-abcdefgh\u001b[31mijklmnop';
    const activities: Array<{ model: string | null }> = [];
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: [
        {
          type: 'system',
          subtype: 'init',
          session_id: '{sessionId}',
          model: disguised,
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: '{sessionId}',
          structured_output: validStructuredResult('execution'),
        },
      ],
    });

    const fact = await runtime.invoke(
      mkRequest(harness, {
        capabilityReport: {
          ...FAKE_CAPABILITY_REPORT,
          version: `Claude ${secret}`,
        },
        onStreamActivity: (activity) => activities.push({ model: activity.model }),
      }),
    );
    const log = await harness.readSessionLog(SESSION_ID);

    expect(fact.model).toBe('[REDACTED]');
    expect(fact.claudeVersion).toBe('Claude [REDACTED]');
    expect(activities.some((activity) => activity.model === '[REDACTED]')).toBe(true);
    expect(log).not.toContain(secret);
    expect(log).not.toContain('\u001b');
  }, TEST_TIMEOUT);

  it('does not flush a multi-line private key at JSON record boundaries', async () => {
    /**
     * 恶意或损坏的 stdout 可能把私钥拆成多行，不能把换行一概视为安全
     * 边界。即使本次调用最终因非 JSON 输出失败，已落盘日志仍不得含原文。
     */
    const privateKeyBody = 'MIIEowIBAAKCAQEA7';
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: [
        '-----BEGIN RSA PRIVATE KEY-----',
        privateKeyBody,
        '-----END RSA PRIVATE KEY-----',
      ],
    });

    await expectApexErrorAsync(() => runtime.invoke(mkRequest(harness)), 'CLAUDE_STREAM_FAILED');
    const log = await harness.readSessionLog(SESSION_ID);
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain(privateKeyBody);
    expect(log).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(parseSessionLog(log).every((record) => record['type'] === 'apex.invalid-stream-fragment')).toBe(
      true,
    );
  }, TEST_TIMEOUT);

  it('replaces valid JSON events when a private key spans record boundaries', async () => {
    /*
     * 每条事件单独看都是合法 JSON，私钥块却跨越两条事件。写入器不能把
     * 两个对象拼接后做文本替换，否则会破坏 JSONL；受影响记录改为安全摘要。
     */
    const privateKeyBody = 'MIIEowIBAAKCAQEA7';
    await harness.writeScenario({
      version: FAKE_VERSION,
      stdoutLines: [
        {
          type: 'system',
          subtype: 'init',
          session_id: '{sessionId}',
          model: 'claude-fake-model',
        },
        {
          type: 'assistant',
          session_id: '{sessionId}',
          message: {
            content: [{ type: 'text', text: '-----BEGIN RSA PRIVATE KEY-----' }],
          },
        },
        {
          type: 'assistant',
          session_id: '{sessionId}',
          message: {
            content: [
              {
                type: 'text',
                text: `${privateKeyBody}\n-----END RSA PRIVATE KEY-----`,
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: '{sessionId}',
          structured_output: validStructuredResult('execution'),
        },
      ],
    });

    const fact = await runtime.invoke(mkRequest(harness));
    const log = await harness.readSessionLog(SESSION_ID);
    const records = parseSessionLog(log);

    expect(fact.exitCode).toBe(0);
    expect(log).not.toContain(privateKeyBody);
    expect(log).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(records).toContainEqual({
      type: 'apex.redacted-records',
      reason: 'record-spanning-secret',
      count: 2,
    });
    expect(records.some((record) => record['type'] === 'result')).toBe(true);
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
    const broken = makeRuntime(harness, {
      claudePath: join(harness.root, 'no-such-claude.exe'),
    });
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
      () => runtime.invoke(mkRequest(harness, { sessionId: 'invalid\u0000session' })),
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
    const failingRuntime = makeRuntime(harness, { fileSystem: failingFileSystem });
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
    expect(report.capabilities).toHaveLength(10);
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
    /**
     * PATH 与 Fake CLI 场景使用同一个执行器级环境快照。
     * 这同时验证 Windows 命令解析和实际子进程观察到完全一致的覆盖值。
     */
    const shimmedRuntime = createClaudeRuntime({
      processExecutor: createTestProcessExecutor({
        ...fakeClaudeEnvironment(harness),
        [pathKey]: `${harness.root};${process.env[pathKey] ?? ''}`,
      }),
      fileSystem: createNodeFileSystem(),
      redaction: createRedactor(),
      probeTimeoutMs: 15_000,
    });
    const report = await shimmedRuntime.probeCapabilities();
    expect(report.version).toBe(FAKE_VERSION);
    expect(report.capabilities).toHaveLength(10);
  }, TEST_TIMEOUT);
});

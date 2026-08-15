/**
 * stream-json 契约的 Golden Fixture 测试。每个 Fixture 描述 Session 类型、
 * 退出码、原始 stdout 行和预期结果；外部失败到唯一稳定错误码的映射由
 * Fixture 与下方边界用例共同覆盖。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createClaudeStreamCollector,
  evaluateStreamOutcome,
} from '../../../src/adapters/claude/stream-parser.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import { ClaudeInvocationError } from '../../../src/application/ports/ClaudeRuntimePort.js';
import type { ErrorCode } from '../../../src/domain/errors.js';
import { UUID_1 } from '../../domain/fixtures.js';

interface FixtureExpectation {
  readonly kind: 'success' | 'error';
  readonly decision?: string;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly errorCode?: ErrorCode;
  readonly messageIncludes?: string;
  readonly toolSummaryIncludes?: string;
  readonly toolSummaryExcludes?: string;
}

interface StreamFixture {
  readonly description: string;
  readonly sessionType: 'planning' | 'plan_review' | 'execution' | 'task_review' | 'final_review';
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: readonly (string | Record<string, unknown>)[];
  readonly expect: FixtureExpectation;
}

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/claude-streams/', import.meta.url));
const redactor = createRedactor();

function loadFixture(file: string): StreamFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as StreamFixture;
}

function fixtureStdout(fixture: StreamFixture): string {
  return fixture.stdout
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
}

function evaluateFixture(fixture: StreamFixture) {
  return evaluateStreamOutcome({
    stdout: fixtureStdout(fixture),
    stderr: fixture.stderr,
    exitCode: fixture.exitCode,
    sessionId: UUID_1,
    sessionType: fixture.sessionType,
    claudeVersion: '1.2.3 (fixture)',
    redact: (text) => redactor.redactText(text),
  });
}

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('stream-json golden fixtures (SPEC §7.2)', () => {
  for (const file of fixtureFiles) {
    const fixture = loadFixture(file);
    it(`${file}: ${fixture.description}`, () => {
      const expectation = fixture.expect;
      if (expectation.kind === 'success') {
        const evaluation = evaluateFixture(fixture);
        expect(evaluation.structuredResult).toBeDefined();
        if (expectation.decision !== undefined) {
          expect(
            (evaluation.structuredResult as { readonly decision?: string }).decision,
          ).toBe(expectation.decision);
        }
        expect(evaluation.model).toBe(expectation.model ?? null);
        expect(evaluation.provider).toBe(expectation.provider ?? null);
        expect(evaluation.stderrSummary).toBeNull();
        return;
      }

      let thrown: unknown;
      try {
        evaluateFixture(fixture);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ClaudeInvocationError);
      const error = thrown as ClaudeInvocationError;
      expect(error.errorCode).toBe(expectation.errorCode);
      expect(error.processExitCode).toBe(fixture.exitCode);
      expect(error.claudeVersion).toBe('1.2.3 (fixture)');
      expect(error.sessionId).toBe(UUID_1);
      if (expectation.messageIncludes !== undefined) {
        expect(error.message).toContain(expectation.messageIncludes);
      }
      if (expectation.toolSummaryIncludes !== undefined) {
        expect(error.toolSummary).toContain(expectation.toolSummaryIncludes);
      }
      if (expectation.toolSummaryExcludes !== undefined) {
        expect(error.toolSummary === null || !error.toolSummary.includes(expectation.toolSummaryExcludes)).toBe(
          true,
        );
      }
    });
  }
});

describe('stream-json inline edge cases', () => {
  const baseInput = {
    stderr: '',
    sessionId: UUID_1,
    sessionType: 'execution' as const,
    claudeVersion: '1.2.3 (fixture)',
    redact: (text: string) => text,
  };

  it('a signal-killed process (null exit code) maps to CLAUDE_EXIT_NONZERO with a null process exit code', () => {
    let thrown: unknown;
    try {
      evaluateStreamOutcome({ ...baseInput, stdout: '', exitCode: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaudeInvocationError);
    const error = thrown as ClaudeInvocationError;
    expect(error.errorCode).toBe('CLAUDE_EXIT_NONZERO');
    expect(error.processExitCode).toBeNull();
    expect(error.message).toContain('signal');
  });

  it('CRLF line endings are tolerated', () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      session_id: UUID_1,
      structured_output: {
        decision: 'completed',
        summary: 'done',
        tests: [],
        acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'seen' }],
        changedAreas: [],
        remainingRisks: [],
        replanReason: null,
      },
    });
    const evaluation = evaluateStreamOutcome({
      ...baseInput,
      stdout: `{"type":"system","subtype":"init","session_id":"${UUID_1}"}\r\n${resultEvent}\r\n`,
      exitCode: 0,
    });
    expect((evaluation.structuredResult as { readonly decision: string }).decision).toBe(
      'completed',
    );
  });

  it('a whitespace-only line is not an empty line and fails the stream contract', () => {
    let thrown: unknown;
    try {
      evaluateStreamOutcome({ ...baseInput, stdout: '   \n', exitCode: 0 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaudeInvocationError);
    expect((thrown as ClaudeInvocationError).errorCode).toBe('CLAUDE_STREAM_FAILED');
  });

  it('第五次连续搜索 StructuredOutput 时判定为工具协议循环', () => {
    const stdout = Array.from({ length: 5 }, (_, index) => [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `call-${index}`,
              name: 'ToolSearch',
              input: { query: 'select:StructuredOutput', max_results: 1 },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: `call-${index}`,
              content: { type: 'tool_reference', tool_name: 'StructuredOutput' },
            },
          ],
        },
      },
    ])
      .flat()
      .map((event) => JSON.stringify(event))
      .join('\n');

    let thrown: unknown;
    try {
      evaluateStreamOutcome({ ...baseInput, stdout, exitCode: null });
    } catch (error) {
      thrown = error;
    }

    /**
     * 子进程因熔断终止时通常没有数字退出码；协议事实必须优先于通用信号
     * 退出映射，否则用户只能看到 CLAUDE_EXIT_NONZERO，无法定位真实循环。
     */
    expect(thrown).toBeInstanceOf(ClaudeInvocationError);
    const invocationError = thrown as ClaudeInvocationError;
    expect(invocationError.errorCode).toBe('CLAUDE_STREAM_FAILED');
    expect(invocationError.processExitCode).toBeNull();
    expect(invocationError.message).toContain('5 consecutive ToolSearch calls');
  });

  it('unknown events cannot supply model or provider metadata', () => {
    const resultEvent = {
      type: 'result',
      session_id: UUID_1,
      structured_output: {
        decision: 'completed',
        summary: 'done',
        tests: [],
        acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'seen' }],
        changedAreas: [],
        remainingRisks: [],
        replanReason: null,
      },
    };
    const stdout = [
      {
        type: 'system',
        subtype: 'init',
        session_id: UUID_1,
        model: 'trusted-init-model',
      },
      {
        type: 'telemetry',
        model: 'untrusted-model',
        provider: 'untrusted-provider',
      },
      resultEvent,
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    const evaluation = evaluateStreamOutcome({ ...baseInput, stdout, exitCode: 0 });
    expect(evaluation.model).toBe('trusted-init-model');
    expect(evaluation.provider).toBeNull();
  });

  it('redacts allowlisted model and provider metadata after extraction', () => {
    const token = 'sk-ant-abcdef1234567890ABCDEF_xyz';
    const stdout = [
      {
        type: 'system',
        subtype: 'init',
        session_id: UUID_1,
        model: `Authorization: Bearer ${token}`,
        provider: `token=${token}`,
      },
      {
        type: 'result',
        session_id: UUID_1,
        structured_output: {
          decision: 'completed',
          summary: 'done',
          tests: [],
          acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'seen' }],
          changedAreas: [],
          remainingRisks: [],
          replanReason: null,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    const evaluation = evaluateStreamOutcome({
      ...baseInput,
      stdout,
      redact: (text) => redactor.redactText(text),
      exitCode: 0,
    });
    expect(evaluation.model).toContain('[REDACTED]');
    expect(evaluation.provider).toContain('[REDACTED]');
    expect(evaluation.model).not.toContain(token);
    expect(evaluation.provider).not.toContain(token);
  });

  it('result contract failures retain a redacted stderr diagnosis', () => {
    const token = 'sk-ant-abcdef1234567890ABCDEF_xyz';
    let thrown: unknown;
    try {
      evaluateStreamOutcome({
        ...baseInput,
        stdout: JSON.stringify({ type: 'system', subtype: 'init', session_id: UUID_1 }),
        stderr: `Authorization: Bearer ${token}`,
        redact: (text) => createRedactor().redactText(text),
        exitCode: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeInvocationError);
    const invocationError = thrown as ClaudeInvocationError;
    expect(invocationError.errorCode).toBe('CLAUDE_RESULT_INVALID');
    expect(invocationError.toolSummary).toContain('[REDACTED]');
    expect(invocationError.toolSummary).not.toContain(token);
  });

  it('redacts terminal failure text before it enters the error message and tool summary', () => {
    /**
     * api_error 的诊断来自 stdout result 事件，安全边界必须与 stderr 完全一致。
     * 即使 Provider 把凭据片段拼进失败正文，也不能进入 CLI 或持久化状态。
     */
    const token = 'sk-ant-abcdef1234567890ABCDEF_xyz';
    const stdout = [
      { type: 'system', subtype: 'init', session_id: UUID_1 },
      {
        type: 'result',
        subtype: 'success',
        session_id: UUID_1,
        is_error: true,
        terminal_reason: 'api_error',
        result: `API Error: Authorization: Bearer ${token}`,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    let thrown: unknown;
    try {
      evaluateStreamOutcome({
        ...baseInput,
        stdout,
        redact: (text) => redactor.redactText(text),
        exitCode: 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeInvocationError);
    const invocationError = thrown as ClaudeInvocationError;
    expect(invocationError.message).toContain('[REDACTED]');
    expect(invocationError.toolSummary).toContain('[REDACTED]');
    expect(invocationError.message).not.toContain(token);
    expect(invocationError.toolSummary).not.toContain(token);
  });

  it('reports explicit record facts for structured logging', () => {
    /**
     * 跨 chunk 的行只在换行到达后确认；首次非法行及其后全部记录都作为
     * untrusted 原文交给日志层封装，日志层无需再次解析或猜测安全边界。
     */
    const collector = createClaudeStreamCollector({ sessionId: UUID_1 });
    const encoder = new TextEncoder();
    expect(collector.push(encoder.encode('{"type":'))).toEqual([]);

    const completed = '"unknown"}\n{"type":"unknown"}\ntail';
    expect(collector.push(encoder.encode(completed))).toEqual([
      { kind: 'event', event: { type: 'unknown' } },
      { kind: 'event', event: { type: 'unknown' } },
    ]);

    expect(collector.push(encoder.encode('\nnot-json\n'))).toEqual([
      { kind: 'untrusted', line: 'tail' },
      { kind: 'untrusted', line: 'not-json' },
    ]);
    expect(collector.push(encoder.encode('{"type":"unknown"}\n'))).toEqual([
      { kind: 'untrusted', line: '{"type":"unknown"}' },
    ]);
  });
});

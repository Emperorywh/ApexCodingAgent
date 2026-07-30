/**
 * DebugFileLogger 适配器测试：JSON Lines 落盘、结构化脱敏、行序保持、
 * 惰性建目录、写失败只诊断不影响后续写入、flush 等待尾部事件。
 */
import { describe, expect, it } from 'vitest';
import { createDebugLogger } from '../../../src/adapters/logging/debug-file-logger.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import type { ClockPort } from '../../../src/application/ports/clock.js';
import { InMemoryFileSystem } from '../state/in-memory-file-system.js';

const clock: ClockPort = { now: () => new Date('2026-07-28T00:00:00.000Z') } as ClockPort;

/**
 * 日志格式正确性依赖结构化脱敏的类型保持语义，因此这里直接使用生产
 * Redactor，避免测试替身绕过真实边界契约。
 */
const redaction = createRedactor();

interface Fixture {
  readonly fs: InMemoryFileSystem;
  readonly mirrorLines: string[];
  readonly failures: string[];
  readonly logger: ReturnType<typeof createDebugLogger>;
}

function createFixture(): Fixture {
  const fs = new InMemoryFileSystem();
  const mirrorLines: string[] = [];
  const failures: string[] = [];
  const logger = createDebugLogger({
    fileSystem: fs,
    clock,
    redaction,
    logPath: '/repo/.apex-coding-agent/logs/apex-debug.log',
    mirror: (line) => mirrorLines.push(line),
    onWriteFailure: (detail) => failures.push(detail),
  });
  return { fs, mirrorLines, failures, logger };
}

const LOG_PATH = '/repo/.apex-coding-agent/logs/apex-debug.log';

describe('debug file logger', () => {
  it('writes redacted JSON lines in call order; flush awaits persistence', async () => {
    const { fs, mirrorLines, logger } = createFixture();

    logger.log('debug', 'run.created', { runId: 'RUN-1', verbose: false });
    const secret = 'sk-proj-abcdefghijklmnop';
    logger.log('error', 'session.invoke.error', {
      errorCode: `upstream ${secret}`,
      token: 42,
      secret: true,
      password: null,
      retry: null,
    });
    await logger.flush();

    const lines = fs
      .readText(LOG_PATH)
      .split('\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toEqual({
      ts: '2026-07-28T00:00:00.000Z',
      level: 'debug',
      event: 'run.created',
      runId: 'RUN-1',
      verbose: false,
    });

    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['level']).toBe('error');
    expect(second['event']).toBe('session.invoke.error');
    /*
     * 结构化脱敏必须保持数字、布尔与 null 的 JSON 类型；审计元数据只记录
     * 规则类别和命中次数，不携带任何秘密派生值。
     */
    expect(second['errorCode']).toBe('upstream [REDACTED]');
    expect(second['token']).toBe(0);
    expect(second['secret']).toBe(false);
    expect(second['password']).toBeNull();
    expect(second['retry']).toBeNull();
    expect(second['redactionMatchCount']).toBe(3);
    expect(second['redactionRules']).toBe('openai-key,sensitive-field');
    expect(lines[1]).not.toContain(secret);

    // 镜像与落盘内容一致（同一已脱敏行）
    expect(mirrorLines).toEqual(lines);
  });

  it('creates the parent directory lazily before the first append', async () => {
    const { fs, logger } = createFixture();
    logger.log('debug', 'first', {});
    await logger.flush();

    const ops = fs.ops.map((op) => op.op);
    const firstAppend = ops.indexOf('appendFile');
    expect(firstAppend).toBeGreaterThan(-1);
    expect(ops.indexOf('mkdir')).toBeLessThan(firstAppend);
    // 第二次写入不再重复建目录
    logger.log('debug', 'second', {});
    await logger.flush();
    expect(fs.ops.filter((op) => op.op === 'mkdir')).toHaveLength(1);
  });

  it('appends across calls without truncating earlier lines', async () => {
    const { fs, logger } = createFixture();
    for (let index = 0; index < 5; index += 1) {
      logger.log('debug', `event.${index}`, {});
    }
    await logger.flush();
    const lines = fs
      .readText(LOG_PATH)
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      'event.0',
      'event.1',
      'event.2',
      'event.3',
      'event.4',
    ]);
  });

  it('a write failure is diagnosed, never thrown, and later writes continue', async () => {
    const { fs, failures, logger } = createFixture();
    fs.injectFailure({ op: 'appendFile', error: new Error('disk full') });

    logger.log('debug', 'lost.line', {});
    logger.log('debug', 'kept.line', {});
    await logger.flush();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('debug log write failed');
    expect(failures[0]).toContain('disk full');

    const content = fs.readText(LOG_PATH);
    expect(content).not.toContain('lost.line');
    expect(content).toContain('kept.line');
  });

  it('flush resolves even when the sink keeps failing', async () => {
    const { fs, failures, logger } = createFixture();
    fs.injectFailure({ op: 'appendFile', error: new Error('e1') });
    fs.injectFailure({ op: 'appendFile', error: new Error('e2') });
    logger.log('warn', 'a', {});
    logger.log('warn', 'b', {});
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(failures).toHaveLength(2);
  });
});

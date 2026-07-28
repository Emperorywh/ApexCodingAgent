/**
 * DebugFileLogger 适配器测试：JSON Lines 落盘、整行脱敏、行序保持、
 * 惰性建目录、写失败只诊断不影响后续写入、flush 等待尾部事件。
 */
import { describe, expect, it } from 'vitest';
import { createDebugLogger } from '../../../src/adapters/logging/debug-file-logger.js';
import type { ClockPort } from '../../../src/application/ports/clock.js';
import type { RedactionPort } from '../../../src/application/ports/redaction.js';
import { InMemoryFileSystem } from '../state/in-memory-file-system.js';

const clock: ClockPort = { now: () => new Date('2026-07-28T00:00:00.000Z') } as ClockPort;

/** 简化脱敏：把 SECRET 替换为占位符，便于断言整行脱敏被调用。 */
const redaction: RedactionPort = {
  redactText: (text) => text.replaceAll('SECRET', '[REDACTED]'),
  redactStructured: (value) => value,
  createChunkRedactor: () => {
    throw new Error('unused in this test');
  },
};

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
    logger.log('error', 'session.invoke.error', { errorCode: 'SECRET-token', retry: null });
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
    // 整行脱敏：字段值中的机密不得落盘
    expect(second['errorCode']).toBe('[REDACTED]-token');
    expect(second['retry']).toBeNull();
    expect(lines[1]).not.toContain('SECRET');

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

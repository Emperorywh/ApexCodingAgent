/**
 * 调试日志 e2e：完整 Run 后 logs/apex-debug.log 落盘关键事件（JSON Lines），
 * 阶段行进 output；verbose 时调试行同步镜像，默认不镜像。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createE2EHarness, executionCompleted, finalReviewCompleted, planDraft, streamOf, COMPLETE_HELP, FAKE_VERSION } from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const ONE_TASK = {
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
} as const;

describe('e2e debug logging', () => {
  it('completed run 落盘结构化调试日志并输出阶段行；默认不镜像', async () => {
    const harness = await createE2EHarness();
    try {
      await seedRepo(harness.repo);
      await harness.writeScenario(ONE_TASK);
      const result = await harness.start();
      expect(result.kind).toBe('completed');

      const log = await readFile(join(harness.stateDir, 'logs', 'apex-debug.log'), 'utf8');
      const events = log
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { event: string }).event);
      expect(events).toContain('startup.settings_resolved');
      expect(events).toContain('startup.probe.end');
      expect(events).toContain('run.created');
      expect(events).toContain('session.invoke.start');
      expect(events).toContain('session.invoke.end');
      expect(events).toContain('driver.plan_committed');
      expect(events).toContain('driver.task_completed');
      expect(events).toContain('driver.run_completed');

      // 会话阶段行（用户可见进度）
      const progress = harness.outputLines;
      expect(progress.some((line) => line.includes('session') && line.includes('planning started'))).toBe(true);
      expect(progress.some((line) => line.includes('finished in') && line.includes('exit 0'))).toBe(true);

      // 启动探测后输出版本行；init 元数据到达后输出模型行
      expect(progress.some((line) => line.includes(`claude version: ${FAKE_VERSION}`))).toBe(true);
      expect(progress.some((line) => line.includes('using model fake-model'))).toBe(true);

      // 默认 verbose=false：调试 JSON 行不镜像到控制台
      expect(progress.some((line) => line.includes('"event":"run.created"'))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  }, 60_000);

  it('verbose=true 时调试日志行同步镜像', async () => {
    const harness = await createE2EHarness();
    try {
      await seedRepo(harness.repo);
      await harness.writeScenario(ONE_TASK);
      const result = await harness.start({ verbose: true });
      expect(result.kind).toBe('completed');

      expect(harness.outputLines.some((line) => line.includes('"event":"run.created"'))).toBe(true);
      expect(harness.outputLines.some((line) => line.includes('"event":"session.invoke.end"'))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 60_000);
});

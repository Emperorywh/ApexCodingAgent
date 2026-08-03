/**
 * G6 CLI 进程级测试设施：以真实子进程运行 `node dist/interfaces/cli/main.js`
 * （产物路径与 bin 入口一致），配临时 Git 仓库与可编程 Fake Claude。
 *
 * 注意：dist 必须先构建（验证门禁 `npm run build && npm test`）；缺失时
 * 本设施先执行一次构建，保证裸 `npm test` 也可用。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SequenceScenario } from '../../e2e/helpers.js';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const CLI_ENTRY = join(REPO_ROOT, 'dist', 'interfaces', 'cli', 'main.js');
export const FAKE_CLAUDE_PATH = fileURLToPath(
  new URL('../../fake-claude/claude.mjs', import.meta.url),
);
export const SIGINT_SCHEDULER_URL = pathToFileURL(
  join(REPO_ROOT, 'tests', 'interfaces', 'cli', 'sigint-scheduler.mjs'),
).href;

let buildVerified = false;

/**
 * 确认进程测试使用 npm test 在 Vitest 启动前生成的新 dist。
 *
 * 构建职责集中在 package.json 的 test 脚本，避免测试并发期间写 dist；
 * 这里仅做防御性断言，禁止静默回退到缺失或未知来源的产物。
 */
export function ensureCliBuilt(): void {
  if (buildVerified) return;
  if (!existsSync(CLI_ENTRY)) {
    throw new Error('CLI dist entry is missing; run tests through `npm test`');
  }
  buildVerified = true;
}

export interface CliOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnCliOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  /** 以 --import 预加载的模块 specifier（测试钩子）。 */
  readonly imports?: readonly string[];
}

export interface CliProcess {
  readonly child: ChildProcess;
  readonly outcome: Promise<CliOutcome>;
}

export function spawnCli(args: readonly string[], options: SpawnCliOptions): CliProcess {
  const importArgs = (options.imports ?? []).flatMap((specifier) => ['--import', specifier]);
  const child = spawn(
    process.execPath,
    [...importArgs, CLI_ENTRY, ...args],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const outcome = new Promise<CliOutcome>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, outcome };
}

/** 带超时的等待；超时先杀子进程再失败。 */
export async function awaitOutcome(
  cli: CliProcess,
  timeoutMs: number,
): Promise<CliOutcome> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      cli.outcome,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cli.child.kill();
          reject(new Error(`CLI process did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface FakeClaudeEnv {
  readonly env: Record<string, string>;
  writeScenario(scenario: SequenceScenario): Promise<void>;
  cleanup(): Promise<void>;
}

/** 每个用例独立的场景/记录文件，避免序列计数器串扰。 */
export async function createFakeClaudeEnv(): Promise<FakeClaudeEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'apex-g6-fake-'));
  const scenarioPath = join(dir, 'scenario.json');
  const recordPath = join(dir, 'invocations.jsonl');
  return {
    env: {
      APEX_FAKE_CLAUDE_SCENARIO: scenarioPath,
      APEX_FAKE_CLAUDE_RECORD: recordPath,
    },
    async writeScenario(scenario) {
      await rm(`${scenarioPath}.counter`, { force: true });
      await writeFile(
        scenarioPath,
        JSON.stringify(
          { autoApprovePlanReviews: true, autoApproveTaskReviews: true, ...scenario },
          null,
          2,
        ),
        'utf8',
      );
    },
    // Windows 上子进程退出滞后时 rmdir 会报 EBUSY，重试吸收
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

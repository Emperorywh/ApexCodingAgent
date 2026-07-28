/**
 * 发布骨架检查（G6、NFR-008、AC-024/025）：
 * - `npm pack` 产物只含 dist 与必要资产（无 tests/src/docs、无 node_modules、
 *   无 .node 原生模块）；
 * - `scripts/scan-forbidden.mjs` 在仓库当前状态通过。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

interface PackEntry {
  readonly files: readonly { readonly path: string }[];
}

function npm(args: readonly string[]): string {
  return execFileSync('npm', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
}

interface ScanFixtureOptions {
  readonly source: string;
  readonly packageJson?: object;
  readonly lock: object;
  readonly installedFiles?: Readonly<Record<string, string>>;
}

/**
 * 创建完全隔离的 AC-025 负向扫描仓库。
 *
 * Fixture 只包含扫描器契约要求的最小 package/src/node_modules 事实，
 * 不修改真实工作区，也不依赖当前依赖树恰好命中某个禁止模式。
 */
async function createScanFixture(options: ScanFixtureOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'apex-g6-scan-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'fixture.ts'), options.source, 'utf8');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(options.packageJson ?? { name: 'scan-fixture', version: '1.0.0' }),
    'utf8',
  );
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(options.lock), 'utf8');
  for (const [path, content] of Object.entries(options.installedFiles ?? {})) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
  return root;
}

/**
 * 运行真实扫描入口并保留失败输出。
 *
 * 使用子进程验证最终 CLI 行为，防止只测试内部正则而遗漏参数解析、
 * lockfile 遍历或退出码接线。
 */
function runForbiddenScan(root: string) {
  return spawnSync(
    process.execPath,
    ['scripts/scan-forbidden.mjs', '--root', root],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

describe('publish skeleton (G6)', () => {
  it('npm pack artifact contains only dist and required assets', () => {
    const output = npm(['pack', '--dry-run', '--json']);
    const entries = JSON.parse(output) as PackEntry[];
    const paths = entries.flatMap((entry) => entry.files.map((file) => file.path));

    expect(paths).toContain('package.json');
    expect(paths).toContain('dist/interfaces/cli/main.js');
    for (const path of paths) {
      expect(path.endsWith('.node'), `native module in artifact: ${path}`).toBe(false);
      expect(
        path === 'package.json' || path.startsWith('dist/'),
        `unexpected file in artifact: ${path}`,
      ).toBe(true);
    }
  }, 60_000);

  it('scan-forbidden.mjs passes on the current tree (AC-025)', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/scan-forbidden.mjs'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(output).toContain('scan-forbidden: OK');
  }, 60_000);

  it('scan-forbidden.mjs rejects Stop and Cancel implementation traces', async () => {
    const root = await createScanFixture({
      source:
        'export function stop(): void {}\n' +
        'export function cancel(): void {}\n',
      lock: {
        name: 'scan-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'scan-fixture', version: '1.0.0' } },
      },
    });
    try {
      const outcome = runForbiddenScan(root);
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toContain('Stop 状态/协议');
      expect(outcome.stderr).toContain('Cancel 状态/协议');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scan-forbidden.mjs follows nested optional production dependencies', async () => {
    const root = await createScanFixture({
      source: 'export const safe = true;\n',
      packageJson: {
        name: 'scan-fixture',
        version: '1.0.0',
        dependencies: { carrier: '1.0.0' },
      },
      lock: {
        name: 'scan-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'scan-fixture',
            version: '1.0.0',
            dependencies: { carrier: '1.0.0' },
          },
          'node_modules/carrier': {
            version: '1.0.0',
            optionalDependencies: { 'native-leaf': '1.0.0' },
          },
          'node_modules/carrier/node_modules/native-leaf': {
            version: '1.0.0',
          },
        },
      },
      installedFiles: {
        'node_modules/carrier/index.js': 'export {};\n',
        'node_modules/carrier/node_modules/native-leaf/addon.node': '',
      },
    });
    try {
      const outcome = runForbiddenScan(root);
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toContain('native-leaf');
      expect(outcome.stderr).toContain('addon.node');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

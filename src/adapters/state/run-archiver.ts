/**
 * Run Archiver（SPEC §4.4 当前 Run 与历史 Run）：把终态 Run 的全部程序
 * 事实自包含、幂等地发布到 `history/<run-id>/`，随后清理根级状态。
 *
 * 发布六步（§4.4）：
 * 1. 在 history/ 下创建仅属于本次归档的 staging 目录；
 * 2. 复制 tasks.json、run.json、plans/、sessions/、logs/ 和存在的 report.md；
 * 3. 生成 archive-manifest.json（相对路径 + 字节长度 + SHA-256；唯一、
 *    稳定排序、不含自身、不逃逸）；
 * 4. 重新读取并校验 staging 目录；
 * 5. 重命名为最终 history/<run-id>/；
 * 6. 最终目录已存在时，仅当 Manifest 与当前终态 Run 完全匹配才算幂等成功，
 *    否则 ARCHIVE_CONFLICT。
 *
 * 发布成功后清理（§4.4）：保留 settings.json；清除根级 tasks.json、
 * run.json、report.md；清空 plans/、sessions/、logs/。归档只复制程序事实，
 * 不切换、修改或删除任何 Branch、Checkpoint 或用户文件。
 */
import { ApexError } from '../../domain/errors.js';
import { isTerminalRunStatus } from '../../domain/run-state.js';
import { validate } from '../../domain/schemas/index.js';
import type {
  RunArchiveManifest,
  RunArchiveManifestFile,
} from '../../domain/schemas/run-archive-manifest.js';
import { migrateRunJsonForRead, type RunJson } from '../../domain/schemas/run-json.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import type { RunArchivePort } from '../../application/ports/run-archive-port.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { ClockPort } from '../../application/ports/clock.js';
import { ensureDirectory, sha256Hex, writeJsonAtomically } from './json-file-writer.js';

export interface RunArchiverOptions {
  /** `.apex-coding-agent/` 状态目录绝对路径，`/` 分隔。 */
  readonly stateDir: string;
  readonly fs: FileSystemPort;
  readonly clock: ClockPort;
}

function archiveFailed(message: string, cause?: unknown): ApexError {
  return new ApexError({ code: 'ARCHIVE_FAILED', stage: 'archive', message, cause });
}

/** 归档内允许出现的相对路径段不得逃逸归档目录（§11.6）。 */
function assertContained(relativePath: string): void {
  const segments = relativePath.split('/');
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw archiveFailed(`archive entry escapes the archive directory: ${relativePath}`);
  }
}

export function createRunArchiver(options: RunArchiverOptions): RunArchivePort {
  const { stateDir, fs, clock } = options;
  const historyDir = `${stateDir}/history`;

  async function pathExists(path: string): Promise<boolean> {
    return (await fs.stat(path)) !== null;
  }

  /** 归档发布前确认一个规范必需事实确实是普通文件。 */
  async function requireRegularFile(path: string, description: string): Promise<void> {
    const stat = await fs.stat(path);
    if (stat === null || !stat.isFile) {
      throw archiveFailed(`required ${description} is missing or not a regular file: ${path}`);
    }
  }

  /**
   * run.json 的 planRevision 决定根级事实的最小完整集合。
   *
   * Revision 0 的失败 Run 合法地没有 tasks/plans；Revision 大于 0 时必须
   * 存在 tasks.json 与 1..N 的全部不可变 Snapshot。completed Run 还必须
   * 保留已验证的 report.md。缺失时在创建 staging 前失败，绝不清理源事实。
   */
  async function assertRequiredRootFacts(run: RunJson): Promise<void> {
    await requireRegularFile(`${stateDir}/run.json`, 'run.json');
    if (run.planRevision > 0) {
      await requireRegularFile(`${stateDir}/tasks.json`, 'tasks.json');
      for (let revision = 1; revision <= run.planRevision; revision += 1) {
        await requireRegularFile(
          `${stateDir}/plans/${revision}.json`,
          `plan revision snapshot ${revision}`,
        );
      }
    }
    if (run.status === 'completed') {
      await requireRegularFile(`${stateDir}/report.md`, 'completed-run report.md');
    }
  }

  /** 递归复制文件与目录；缺失的可选来源静默跳过。 */
  async function copyTree(source: string, target: string, required: boolean): Promise<void> {
    const stat = await fs.stat(source);
    if (stat === null) {
      if (required) throw archiveFailed(`required state file is missing: ${source}`);
      return;
    }
    if (stat.isFile) {
      await ensureDirectory(fs, target.slice(0, target.lastIndexOf('/')));
      await fs.writeFile(target, await fs.readFile(source));
      return;
    }
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      await copyTree(`${source}/${entry.name}`, `${target}/${entry.name}`, true);
    }
  }

  /** 收集 staging 内全部普通文件（排除 Manifest 自身），稳定排序。 */
  async function collectFiles(stagingDir: string): Promise<RunArchiveManifestFile[]> {
    const files: RunArchiveManifestFile[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fs.readdir(dir)) {
        const absolute = `${dir}/${entry.name}`;
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(absolute, relative);
        } else if (entry.isFile && relative !== 'archive-manifest.json') {
          assertContained(relative);
          const bytes = await fs.readFile(absolute);
          files.push({ path: relative, byteLength: bytes.length, sha256: sha256Hex(bytes) });
        }
      }
    };
    await walk(stagingDir, '');
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return files;
  }

  /** 第 4 步：重读 staging 并逐文件校验 Manifest 与归档 run.json。 */
  async function verifyStaging(stagingDir: string, manifest: RunArchiveManifest): Promise<void> {
    for (const file of manifest.files) {
      const bytes = await fs.readFile(`${stagingDir}/${file.path}`);
      if (bytes.length !== file.byteLength || sha256Hex(bytes) !== file.sha256) {
        throw archiveFailed(`staging verification failed for ${file.path}`);
      }
    }
    const manifestBytes = await fs.readFile(`${stagingDir}/archive-manifest.json`);
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    const result = validate('RunArchiveManifest', parsed);
    if (!result.valid) throw archiveFailed('staging manifest failed schema validation');
    const archivedRun: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await fs.readFile(`${stagingDir}/run.json`),
      ),
    );
    /**
     * 与 StateStore 读取一致走读取兼容迁移：resume 功能前写入的旧
     * run.json 缺 resumePoint，归档必须能发布这类历史终态 Run。归档字节
     * 保持原样（历史事实原样复制），仅在校验前回填缺失字段。
     */
    const migratedRun = migrateRunJsonForRead(archivedRun);
    const runValidation = validate('RunJson', migratedRun);
    if (!runValidation.valid) {
      const detail = runValidation.issues
        .map((issue) => `${issue.path} (${issue.keyword}): ${issue.message}`)
        .join('; ');
      throw archiveFailed(`staging run.json failed schema validation: ${detail}`);
    }
    const validatedRun = migratedRun as RunJson;
    if (validatedRun.runId !== manifest.runId || validatedRun.status !== manifest.runStatus) {
      throw archiveFailed('staging run.json does not match the manifest run identity');
    }

    /**
     * Manifest 必须精确覆盖 staging 中的全部普通文件。仅逐条验证 Manifest
     * 无法发现生成后新增的额外文件，因此重新收集并做稳定清单比较。
     */
    const actualFiles = await collectFiles(stagingDir);
    const exactCoverage =
      actualFiles.length === manifest.files.length &&
      actualFiles.every((file, index) => {
        const expected = manifest.files[index];
        return (
          expected !== undefined &&
          file.path === expected.path &&
          file.byteLength === expected.byteLength &&
          file.sha256 === expected.sha256
        );
      });
    if (!exactCoverage) {
      throw archiveFailed('staging manifest does not exactly cover all ordinary files');
    }
  }

  /** Manifest 幂等比较：runId、runStatus 与文件清单完全一致（archivedAt 除外）。 */
  function manifestsMatch(a: RunArchiveManifest, b: RunArchiveManifest): boolean {
    return (
      a.runId === b.runId &&
      a.runStatus === b.runStatus &&
      a.files.length === b.files.length &&
      a.files.every((file, index) => {
        const other = b.files[index];
        return (
          other !== undefined &&
          file.path === other.path &&
          file.byteLength === other.byteLength &&
          file.sha256 === other.sha256
        );
      })
    );
  }

  async function archiveTerminalRun(run: RunJson): Promise<void> {
    if (!isTerminalRunStatus(run.status)) {
      throw archiveFailed(`run ${run.runId} is ${run.status}; only terminal runs can be archived`);
    }
    const runStatus = run.status as RunArchiveManifest['runStatus'];
    const runId = run.runId;
    const stagingDir = `${historyDir}/.staging-${runId}`;
    const finalDir = `${historyDir}/${runId}`;

    try {
      await assertRequiredRootFacts(run);

      // 第 1 步：仅属于本次归档的 staging；同目标的旧 staging 幂等清除（§4.4）。
      await fs.mkdir(historyDir, { recursive: true });
      if (await pathExists(stagingDir)) await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });

      // 第 2 步：按 Run 阶段复制规范事实；仅 Revision 0 可缺 tasks/plans。
      await copyTree(`${stateDir}/run.json`, `${stagingDir}/run.json`, true);
      await copyTree(
        `${stateDir}/tasks.json`,
        `${stagingDir}/tasks.json`,
        run.planRevision > 0,
      );
      await copyTree(`${stateDir}/plans`, `${stagingDir}/plans`, run.planRevision > 0);
      await copyTree(`${stateDir}/sessions`, `${stagingDir}/sessions`, false);
      await copyTree(`${stateDir}/logs`, `${stagingDir}/logs`, false);
      await copyTree(
        `${stateDir}/report.md`,
        `${stagingDir}/report.md`,
        run.status === 'completed',
      );

      // 第 3 步：生成 Manifest（不含自身）。
      const manifest: RunArchiveManifest = {
        schemaVersion: 1,
        runId,
        runStatus,
        archivedAt: formatRfc3339Utc(clock.now()),
        files: await collectFiles(stagingDir),
      };
      const manifestValidation = validate('RunArchiveManifest', manifest);
      if (!manifestValidation.valid) {
        throw archiveFailed('generated manifest failed schema validation');
      }
      await writeJsonAtomically(fs, {
        targetPath: `${stagingDir}/archive-manifest.json`,
        value: manifest,
        schemaName: 'RunArchiveManifest',
      });

      // 第 4 步：重读并校验 staging。
      await verifyStaging(stagingDir, manifest);

      // 第 5–6 步：发布或幂等裁决。
      if (await pathExists(finalDir)) {
        let existing: RunArchiveManifest | null = null;
        try {
          const bytes = await fs.readFile(`${finalDir}/archive-manifest.json`);
          const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          if (validate('RunArchiveManifest', parsed).valid) {
            existing = parsed as RunArchiveManifest;
            /**
             * 幂等成功不能只信任 Manifest 文本；历史目录可能被截断或篡改。
             * 复用发布前的完整重读校验，确认所有清单文件仍存在、哈希匹配，
             * 且目录没有未入清单的额外普通文件。
             */
            await verifyStaging(finalDir, existing);
          }
        } catch {
          existing = null;
        }
        if (existing !== null && manifestsMatch(existing, manifest)) {
          // 幂等成功：同一终态 Run 的重复归档。
          await fs.rm(stagingDir, { recursive: true, force: true });
        } else {
          await fs.rm(stagingDir, { recursive: true, force: true });
          throw new ApexError({
            code: 'ARCHIVE_CONFLICT',
            stage: 'archive',
            message: `history/${runId} already exists with a non-matching manifest`,
          });
        }
      } else {
        await fs.rename(stagingDir, finalDir);
      }

      // 发布后清理：保留 settings.json，清除根级 Run 事实与旧目录内容。
      for (const rootFile of ['run.json', 'tasks.json', 'report.md']) {
        if (await pathExists(`${stateDir}/${rootFile}`)) {
          await fs.unlink(`${stateDir}/${rootFile}`);
        }
      }
      for (const dir of ['plans', 'sessions', 'logs']) {
        if (await pathExists(`${stateDir}/${dir}`)) {
          await fs.rm(`${stateDir}/${dir}`, { recursive: true, force: true });
        }
        await fs.mkdir(`${stateDir}/${dir}`, { recursive: true });
      }
    } catch (error) {
      if (error instanceof ApexError) throw error;
      throw archiveFailed(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }

  return { archiveTerminalRun };
}

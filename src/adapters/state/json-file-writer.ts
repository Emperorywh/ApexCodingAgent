/**
 * JSON write protocol and validated reads for the state store (SPEC §11.2).
 *
 * Write protocol: serialize → same-directory temp file → close → rename →
 * reopen and schema-validate. UTF-8 without BOM. No previous files, no
 * journal, no cross-file transaction — and no guessing at corrupt state.
 *
 * The rename step tolerates transient sharing violations (bounded backoff,
 * see {@link renameReplacing}): on Windows a file handle carries no delete
 * sharing, so a concurrent reader holding the target for a few milliseconds
 * (a polling `readFile`, another CLI process running a consistent read, an
 * antivirus/indexer scan) makes `rename` fail with EPERM/EACCES/EBUSY even
 * though the replacement would succeed a moment later.
 *
 * Error mapping (SPEC §15.3 state_error row): I/O failures anywhere in the
 * protocol (temp write, rename, reopen, mkdir) map to `STATE_WRITE_FAILED`;
 * content failures (invalid UTF-8/JSON, schema or Domain rule violations)
 * map to `STATE_VALIDATION_FAILED`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import { ApexError } from '../../domain/errors.js';
import { assertSchemaValid, type SchemaName } from '../../domain/schemas/index.js';

const STATE_STAGE = 'state';

export function stateWriteFailed(message: string, cause?: unknown): ApexError {
  return new ApexError({
    code: 'STATE_WRITE_FAILED',
    stage: STATE_STAGE,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function stateValidationFailed(message: string, cause?: unknown): ApexError {
  return new ApexError({
    code: 'STATE_VALIDATION_FAILED',
    stage: STATE_STAGE,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

/** SHA-256 as 64 lowercase hex chars over the raw bytes (SPEC §11.5). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** UTF-8 (no BOM) serialization used for every persisted JSON document. */
export function serializeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

export function parseStateJson(bytes: Uint8Array, path: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw stateValidationFailed(`${path} is not valid UTF-8`, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw stateValidationFailed(`${path} is not valid JSON`, error);
  }
}

/**
 * Same-directory temp file name (SPEC §11.2). Random suffix, never a PID;
 * the temp file is unlinked on rename failure and never left as a
 * `*.previous`-style fallback.
 */
export function tempPathFor(targetPath: string): string {
  const slash = targetPath.lastIndexOf('/');
  const dir = slash >= 0 ? targetPath.slice(0, slash) : '.';
  const base = slash >= 0 ? targetPath.slice(slash + 1) : targetPath;
  return `${dir}/.${base}.tmp-${randomBytes(6).toString('hex')}`;
}

export interface AtomicJsonWrite {
  readonly targetPath: string;
  readonly value: unknown;
  readonly schemaName: SchemaName;
  /** Extra Domain rules (e.g. invariants); must throw STATE_VALIDATION_FAILED. */
  readonly preValidate?: () => void;
}

/**
 * Windows 上 rename 替换目标时的瞬态共享冲突错误码：Node 打开的文件句柄
 * 不带删除共享，目标文件被并发读者（轮询读、另一个 CLI 进程、杀毒/索引
 * 扫描）短暂持有期间，替换式 rename 一律以这些码失败。持有者毫秒内就会
 * 关闭，属于可退避吸收的瞬态，而非真实的权限/路径问题。
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** 重试预算：指数退避 10→20→…→100ms，总等待约 1 秒，远超一次读取的持有窗口。 */
const RENAME_MAX_ATTEMPTS = 12;
const RENAME_INITIAL_DELAY_MS = 10;
const RENAME_MAX_DELAY_MS = 100;

function transientRenameCode(error: unknown): boolean {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * 替换式 rename，带瞬态共享冲突的有界退避重试。
 *
 * 没有这层重试时，一次几毫秒的读取竞速就足以让 rename 抛出 EPERM，进而
 * 把整个 Run 以 STATE_WRITE_FAILED 杀死；重试只作用于 rename 步骤本身，
 * 不改变写协议形态（临时文件在重试间保持不变，读者仍只见旧版或新版全文）。
 */
export async function renameReplacing(
  fs: FileSystemPort,
  from: string,
  to: string,
): Promise<void> {
  let delayMs = RENAME_INITIAL_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !transientRenameCode(error)) throw error;
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
      delayMs = Math.min(delayMs * 2, RENAME_MAX_DELAY_MS);
    }
  }
}

/**
 * Full write protocol. The aggregate is schema- and Domain-validated before
 * any byte hits the filesystem (SPEC §5.5); after the rename the target is
 * reopened and schema-validated again. Returns the reopened raw bytes (the
 * basis for tasks.json SHA-256).
 */
export async function writeJsonAtomically(
  fs: FileSystemPort,
  write: AtomicJsonWrite,
): Promise<Uint8Array> {
  assertSchemaValid(write.schemaName, write.value, {
    code: 'STATE_VALIDATION_FAILED',
    stage: STATE_STAGE,
  });
  write.preValidate?.();

  const bytes = serializeJson(write.value);
  const tempPath = tempPathFor(write.targetPath);
  try {
    await fs.writeFile(tempPath, bytes);
  } catch (error) {
    throw stateWriteFailed(`failed to write temporary file for ${write.targetPath}`, error);
  }
  try {
    await renameReplacing(fs, tempPath, write.targetPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw stateWriteFailed(`failed to replace ${write.targetPath}`, error);
  }
  let reread: Uint8Array;
  try {
    reread = await fs.readFile(write.targetPath);
  } catch (error) {
    throw stateWriteFailed(`failed to reopen ${write.targetPath} after replacement`, error);
  }
  assertSchemaValid(write.schemaName, parseStateJson(reread, write.targetPath), {
    code: 'STATE_VALIDATION_FAILED',
    stage: STATE_STAGE,
  });
  return reread;
}

export interface ReadJsonResult<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
}

/**
 * Reads, parses and schema-validates a JSON state file. Returns `null` when
 * the file does not exist; any other I/O or content failure maps to
 * `STATE_VALIDATION_FAILED` (the state cannot be obtained in valid form).
 * 状态契约不做读取迁移：缺字段或旧结构必须直接失败，避免持久化事实被
 * 读取层静默改写后产生不可推导的混合版本状态。
 */
export async function readJsonIfExists<T>(
  fs: FileSystemPort,
  path: string,
  schemaName: SchemaName,
  rules?: (value: T) => void,
): Promise<ReadJsonResult<T> | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw stateValidationFailed(`failed to read ${path}`, error);
  }
  const parsed = parseStateJson(bytes, path);
  assertSchemaValid(schemaName, parsed, { code: 'STATE_VALIDATION_FAILED', stage: STATE_STAGE });
  const value = parsed as T;
  rules?.(value);
  return { value, bytes };
}

/** mkdir -p for a state subdirectory; I/O failures map to STATE_WRITE_FAILED. */
export async function ensureDirectory(fs: FileSystemPort, path: string): Promise<void> {
  try {
    await fs.mkdir(path, { recursive: true });
  } catch (error) {
    throw stateWriteFailed(`failed to create state directory ${path}`, error);
  }
}

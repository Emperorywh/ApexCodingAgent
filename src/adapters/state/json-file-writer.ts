/**
 * JSON write protocol and validated reads for the state store (SPEC §11.2).
 *
 * Write protocol: serialize → same-directory temp file → close → rename →
 * reopen and schema-validate. UTF-8 without BOM. No previous files, no
 * journal, no cross-file transaction — and no guessing at corrupt state.
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
    await fs.rename(tempPath, write.targetPath);
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
 * `normalize` runs between parse and validation for schema-version-internal
 * read migrations (e.g. backfilling fields added after older files were
 * written); it must never guess at corrupt content.
 */
export async function readJsonIfExists<T>(
  fs: FileSystemPort,
  path: string,
  schemaName: SchemaName,
  rules?: (value: T) => void,
  normalize?: (parsed: unknown) => unknown,
): Promise<ReadJsonResult<T> | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw stateValidationFailed(`failed to read ${path}`, error);
  }
  const parsed = parseStateJson(bytes, path);
  const migrated = normalize === undefined ? parsed : normalize(parsed);
  assertSchemaValid(schemaName, migrated, { code: 'STATE_VALIDATION_FAILED', stage: STATE_STAGE });
  const value = migrated as T;
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

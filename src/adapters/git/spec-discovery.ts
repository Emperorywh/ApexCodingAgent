/**
 * SPEC discovery and validation (SPEC §3.2).
 *
 * Default discovery lists `git ls-files --cached --others --exclude-standard`
 * and keeps entries whose file name is strictly `SPEC.md` outside `.git/` and
 * `.apex-coding-agent/` — ignored directories are never traversed by Git
 * itself, so an ignored SPEC is only reachable through an explicit path.
 * Discovery is scoped to the invocation directory subtree: in a repository
 * hosting several projects (monorepo), `start` only considers the SPEC.md
 * files under the directory it was invoked from, so sibling projects no
 * longer make the default discovery ambiguous. Invoking at the repository
 * root keeps the previous repository-wide behavior.
 *
 * Explicit paths resolve against the command invocation directory; both the
 * lexical path and the real path must stay inside the repository root
 * (`SPEC_OUTSIDE_REPOSITORY`), which catches `..` escapes and symlink /
 * Windows Junction redirection. The normalized identity is the `/`-separated
 * Git-relative path.
 *
 * File validation: regular file (`SPEC_NOT_REGULAR_FILE`), readable
 * (`SPEC_NOT_READABLE`), strict UTF-8 with an optional BOM
 * (`SPEC_INVALID_UTF8`), non-empty content (`SPEC_EMPTY`); SHA-256 is always
 * computed over the raw bytes, BOM included.
 */
import { createHash } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApexError } from '../../domain/errors.js';
import { isGitRelativePath } from '../../domain/paths.js';
import type { SpecFact } from '../../application/ports/GitPort.js';
import type { GitRunner } from './cli.js';

const SPEC_STAGE = 'spec-discovery';
const SPEC_FILE_NAME = 'SPEC.md';
const STATE_DIR_PREFIX = '.apex-coding-agent/';
const GIT_DIR_PREFIX = '.git/';
// Case-insensitive containment on Windows and on macOS, whose default
// filesystems (NTFS; HFS+/APFS) fold case. Linux filesystems compare
// case-sensitively. On a case-sensitive macOS volume this is a conservative
// relaxation whose worst failure mode is treating two casings of a path as the
// same lexical entry; such a path would not exist on that volume anyway and
// still fails realpath validation below.
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

function specError(code: 'SPEC_NOT_FOUND' | 'SPEC_AMBIGUOUS' | 'SPEC_EMPTY' | 'SPEC_NOT_REGULAR_FILE' | 'SPEC_NOT_READABLE' | 'SPEC_INVALID_UTF8' | 'SPEC_OUTSIDE_REPOSITORY' | 'SPEC_STAGED', message: string, cause?: unknown): ApexError {
  return new ApexError({
    code,
    stage: SPEC_STAGE,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

// ---------------------------------------------------------------------------
// Path normalization helpers (pure; unit-tested directly)

function foldCase(value: string): string {
  return FOLDS_CASE ? value.toLowerCase() : value;
}

function splitAbsolute(absolutePath: string): string[] {
  return resolve(absolutePath)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
}

/**
 * Containment of `childPath` inside `rootPath`.
 * Both are resolved lexically first; segment comparison folds case on Windows
 * and macOS (default case-insensitive filesystems).
 */
export function isPathInside(childPath: string, rootPath: string): boolean {
  const child = splitAbsolute(childPath).map(foldCase);
  const root = splitAbsolute(rootPath).map(foldCase);
  if (child.length < root.length) return false;
  return root.every((segment, index) => segment === child[index]);
}

/**
 * `/`-separated path of `childPath` relative to `rootPath`, preserving the
 * child's own casing. Caller must have established containment already.
 */
export function toGitRelativePath(rootPath: string, childPath: string): string {
  const child = splitAbsolute(childPath);
  const root = splitAbsolute(rootPath);
  return child.slice(root.length).join('/');
}

// ---------------------------------------------------------------------------
// Default discovery

/** Default-discovery candidate Git paths (SPEC §3.2), scoped to the invocation directory subtree. */
export async function discoverSpecCandidates(git: GitRunner, root: string, cwd: string): Promise<string[]> {
  const { stdout } = await git.run(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root,
  );
  const prefix = invocationSubtreePrefix(root, cwd);
  return stdout
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.startsWith(GIT_DIR_PREFIX) && !entry.startsWith(STATE_DIR_PREFIX))
    .filter((entry) => {
      const slash = entry.lastIndexOf('/');
      const name = slash >= 0 ? entry.slice(slash + 1) : entry;
      return name === SPEC_FILE_NAME;
    })
    .filter((entry) => prefix === '' || foldCase(entry).startsWith(foldCase(prefix)));
}

/**
 * Git-relative subtree prefix of the invocation directory, `''` when invoked
 * at the repository root (discovery then spans the whole repository).
 */
function invocationSubtreePrefix(root: string, cwd: string): string {
  if (!isPathInside(cwd, root)) return '';
  const relative = toGitRelativePath(root, cwd);
  return relative === '' ? '' : `${relative}/`;
}

// ---------------------------------------------------------------------------
// Explicit path resolution

interface ExplicitSpecPath {
  readonly gitPath: string;
  readonly absolutePath: string;
}

async function resolveExplicitSpecPath(
  root: string,
  cwd: string,
  explicitPath: string,
): Promise<ExplicitSpecPath> {
  const absolutePath = resolve(cwd, explicitPath);
  const realRoot = await realpath(root).catch(() => root);

  // Lexical containment first: a path escaping the root is rejected even
  // when the target does not exist (SPEC_OUTSIDE_REPOSITORY beats
  // SPEC_NOT_FOUND for escaping paths).
  const lexicalInside = isPathInside(absolutePath, root) || isPathInside(absolutePath, realRoot);
  if (!lexicalInside) {
    throw specError(
      'SPEC_OUTSIDE_REPOSITORY',
      `SPEC path ${explicitPath} is outside the repository root`,
    );
  }

  let realFile: string;
  try {
    realFile = await realpath(absolutePath);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw code === 'ENOENT'
      ? specError('SPEC_NOT_FOUND', `explicit SPEC path does not exist: ${explicitPath}`, error)
      : specError('SPEC_NOT_READABLE', `cannot resolve SPEC path: ${explicitPath}`, error);
  }
  if (!isPathInside(realFile, realRoot)) {
    throw specError(
      'SPEC_OUTSIDE_REPOSITORY',
      `SPEC path ${explicitPath} resolves outside the repository root`,
    );
  }

  const lexicalBase = isPathInside(absolutePath, root) ? root : realRoot;
  const lexicalRelative = toGitRelativePath(lexicalBase, absolutePath);
  const realRelative = toGitRelativePath(realRoot, realFile);
  // Prefer the real path's true on-disk casing (Win32 realpath normalizes it);
  // fall back to the lexical path when a repo-internal symlink redirects the
  // real path elsewhere — Git tracks the lexical entry.
  const gitPath =
    foldCase(lexicalRelative) === foldCase(realRelative) ? realRelative : lexicalRelative;
  return { gitPath, absolutePath };
}

// ---------------------------------------------------------------------------
// File validation + hashing

/** Reads and validates the SPEC file; returns its raw-byte SHA-256. */
export async function readSpecFile(absolutePath: string): Promise<{ readonly sha256: string }> {
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw code === 'ENOENT'
      ? specError('SPEC_NOT_FOUND', `SPEC file not found: ${absolutePath}`, error)
      : specError('SPEC_NOT_READABLE', `SPEC file is not readable: ${absolutePath}`, error);
  }
  if (!fileStat.isFile()) {
    throw specError('SPEC_NOT_REGULAR_FILE', `SPEC path is not a regular file: ${absolutePath}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw code === 'ENOENT'
      ? specError('SPEC_NOT_FOUND', `SPEC file not found: ${absolutePath}`, error)
      : specError('SPEC_NOT_READABLE', `SPEC file is not readable: ${absolutePath}`, error);
  }
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw specError('SPEC_INVALID_UTF8', `SPEC file is not valid UTF-8: ${absolutePath}`, error);
  }
  if (body.length === 0) {
    throw specError('SPEC_EMPTY', `SPEC file is empty: ${absolutePath}`);
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** `true` when the SPEC file has staged (index vs HEAD) changes. */
export async function isSpecStaged(git: GitRunner, root: string, gitPath: string): Promise<boolean> {
  const { stdout } = await git.run(['diff', '--cached', '--name-only', '-z', '--', gitPath], root);
  return stdout.split('\0').some((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Port-level compositions

/** Full SPEC §3.2 resolution: discovery or explicit path + validation + staged check. */
export async function resolveSpecFact(
  git: GitRunner,
  root: string,
  cwd: string,
  explicitPath: string | null,
): Promise<SpecFact> {
  let gitPath: string;
  let absolutePath: string;
  if (explicitPath === null) {
    const candidates = await discoverSpecCandidates(git, root, cwd);
    if (candidates.length === 0) {
      throw specError(
        'SPEC_NOT_FOUND',
        'no SPEC.md found in tracked or untracked files under the invocation directory',
      );
    }
    if (candidates.length > 1) {
      throw specError(
        'SPEC_AMBIGUOUS',
        `multiple SPEC.md candidates (${candidates.join(', ')}); pass an explicit path`,
      );
    }
    gitPath = candidates[0]!;
    absolutePath = resolve(root, gitPath);
  } else {
    ({ gitPath, absolutePath } = await resolveExplicitSpecPath(root, cwd, explicitPath));
  }
  const { sha256 } = await readSpecFile(absolutePath);
  if (await isSpecStaged(git, root, gitPath)) {
    throw specError('SPEC_STAGED', `SPEC file has staged changes: ${gitPath}`);
  }
  return { gitPath, absolutePath, sha256 };
}

/**
 * 在每个 SPEC 重算边界重新验证权威路径。
 *
 * 持久化 Schema 会先拒绝绝对路径和 `..`，这里仍按真实路径再次校验，
 * 以防 Run 期间符号链接或 Junction 的目标发生变化并逃逸仓库。
 */
export async function readSpecFact(
  git: GitRunner,
  root: string,
  gitPath: string,
): Promise<SpecFact> {
  if (!isGitRelativePath(gitPath)) {
    throw specError(
      'SPEC_OUTSIDE_REPOSITORY',
      `stored SPEC path is not a valid Git-relative path: ${gitPath}`,
    );
  }
  // 权威身份仍是持久化的 gitPath；realpath 重算结果只用于包含关系校验。
  const { absolutePath } = await resolveExplicitSpecPath(root, root, gitPath);
  const { sha256 } = await readSpecFile(absolutePath);
  return { gitPath, absolutePath, sha256 };
}

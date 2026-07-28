/**
 * FileSystemPort (SPEC §5.2 Application Ports, NFR-005).
 *
 * Minimal filesystem surface required by the state store and later sessions
 * (Git, archiving, startup checks). Implementations live in
 * `src/adapters/filesystem/`; tests substitute in-memory fakes. Later sessions
 * may add methods but must not change these signatures.
 *
 * Errors: implementations throw the raw platform error (Node system errors
 * carry a `code`, e.g. ENOENT) except {@link FileSystemPort.stat}, which
 * returns `null` for a missing path instead of throwing.
 */

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface MkdirOptions {
  readonly recursive?: boolean;
}

export interface RmOptions {
  readonly recursive?: boolean;
  readonly force?: boolean;
}

export interface FileSystemPort {
  /** Raw bytes of the file at `path` (SHA-256 is always computed over raw bytes). */
  readFile(path: string): Promise<Uint8Array>;
  /** Creates or truncates the file at `path` with exactly `data`. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Atomically replaces `to` with `from` (same-directory temp-file protocol). */
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  /** Direct children of `path`, sorted by name for deterministic behavior. */
  readdir(path: string): Promise<DirectoryEntry[]>;
  /** Metadata for `path`, or `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Canonical absolute path (resolves symlinks and `.`/`..`). */
  realpath(path: string): Promise<string>;
  /** Removes a single file; fails when the path does not exist. */
  unlink(path: string): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
}

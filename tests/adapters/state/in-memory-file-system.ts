/**
 * In-memory FileSystemPort for adapter tests: full port surface, an
 * operation log (for commit-order and no-write assertions), one-shot failure
 * injection (write/rename/reread fault injection) and a read interceptor
 * (for consistent-read mismatch scripting).
 */
import type {
  DirectoryEntry,
  FileStat,
  FileSystemPort,
  MkdirOptions,
  RmOptions,
} from '../../../src/application/ports/file-system.js';

export type FsOp =
  | 'readFile'
  | 'writeFile'
  | 'appendFile'
  | 'rename'
  | 'mkdir'
  | 'readdir'
  | 'stat'
  | 'realpath'
  | 'unlink'
  | 'rm';

export interface FsOpRecord {
  readonly op: FsOp;
  readonly path: string;
  readonly to?: string;
}

export interface InjectedFailure {
  readonly op: FsOp;
  /** Restricts the failure to paths containing this substring. */
  readonly pathIncludes?: string;
  /** Mutable countdown: this many matching calls pass before the failure fires. */
  afterMatchingCalls?: number;
  readonly error: Error;
}

export function enoent(path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, ${path}`) as Error & {
    code?: string;
  };
  error.code = 'ENOENT';
  return error;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export class InMemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(['/']);
  readonly ops: FsOpRecord[] = [];
  /** Rewrites bytes returned by readFile (after failure injection). */
  readInterceptor: ((path: string, bytes: Uint8Array) => Uint8Array) | null = null;
  private failures: InjectedFailure[] = [];

  injectFailure(failure: InjectedFailure): void {
    this.failures.push(failure);
  }

  readText(path: string): string {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw enoent(path);
    return new TextDecoder().decode(bytes);
  }

  private record(op: FsOp, path: string, to?: string): void {
    this.ops.push({ op, path, ...(to === undefined ? {} : { to }) });
  }

  private maybeFail(op: FsOp, path: string): void {
    for (const failure of this.failures) {
      if (failure.op !== op) continue;
      if (failure.pathIncludes !== undefined && !path.includes(failure.pathIncludes)) continue;
      if (failure.afterMatchingCalls !== undefined && failure.afterMatchingCalls > 0) {
        failure.afterMatchingCalls -= 1;
        continue;
      }
      this.failures = this.failures.filter((entry) => entry !== failure);
      throw failure.error;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.record('readFile', path);
    this.maybeFail('readFile', path);
    const bytes = this.files.get(path);
    if (bytes === undefined) throw enoent(path);
    return this.readInterceptor === null ? bytes : this.readInterceptor(path, bytes);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.record('writeFile', path);
    this.maybeFail('writeFile', path);
    this.dirs.add(parentOf(path));
    this.files.set(path, data);
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    this.record('appendFile', path);
    this.maybeFail('appendFile', path);
    this.dirs.add(parentOf(path));
    const existing = this.files.get(path);
    const combined = new Uint8Array((existing?.length ?? 0) + data.length);
    if (existing !== undefined) combined.set(existing, 0);
    combined.set(data, existing?.length ?? 0);
    this.files.set(path, combined);
  }

  async rename(from: string, to: string): Promise<void> {
    this.record('rename', from, to);
    this.maybeFail('rename', from);
    const bytes = this.files.get(from);
    if (bytes === undefined) throw enoent(from);
    this.files.delete(from);
    this.dirs.add(parentOf(to));
    this.files.set(to, bytes);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.record('mkdir', path);
    this.maybeFail('mkdir', path);
    if (options?.recursive === true) {
      let current = '';
      for (const segment of path.split('/')) {
        current = current === '' ? segment : `${current}/${segment}`;
        if (current !== '') this.dirs.add(current);
      }
    } else {
      this.dirs.add(path);
    }
  }

  async readdir(path: string): Promise<DirectoryEntry[]> {
    this.record('readdir', path);
    this.maybeFail('readdir', path);
    if (!this.dirs.has(path)) throw enoent(path);
    const entries: DirectoryEntry[] = [];
    const seen = new Set<string>();
    const consider = (candidate: string, isFile: boolean): void => {
      if (parentOf(candidate) !== path) return;
      const name = candidate.slice(path.length + (path === '/' ? 0 : 1));
      if (name === '' || seen.has(name)) return;
      seen.add(name);
      entries.push({ name, isFile, isDirectory: !isFile });
    };
    for (const file of this.files.keys()) consider(file, true);
    for (const dir of this.dirs) {
      if (dir !== path) consider(dir, false);
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async stat(path: string): Promise<FileStat | null> {
    this.record('stat', path);
    this.maybeFail('stat', path);
    const bytes = this.files.get(path);
    if (bytes !== undefined) {
      return { isFile: true, isDirectory: false, size: bytes.length, mtimeMs: 0 };
    }
    if (this.dirs.has(path)) {
      return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
    }
    return null;
  }

  async realpath(path: string): Promise<string> {
    this.record('realpath', path);
    this.maybeFail('realpath', path);
    if (!this.files.has(path) && !this.dirs.has(path)) throw enoent(path);
    return path;
  }

  async unlink(path: string): Promise<void> {
    this.record('unlink', path);
    this.maybeFail('unlink', path);
    if (!this.files.delete(path)) throw enoent(path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.record('rm', path);
    this.maybeFail('rm', path);
    if (this.files.delete(path)) return;
    if (this.dirs.has(path) && options?.recursive === true) {
      const prefix = `${path}/`;
      for (const file of [...this.files.keys()]) {
        if (file.startsWith(prefix)) this.files.delete(file);
      }
      for (const dir of [...this.dirs]) {
        if (dir === path || dir.startsWith(prefix)) this.dirs.delete(dir);
      }
      return;
    }
    if (options?.force === true) return;
    throw enoent(path);
  }
}

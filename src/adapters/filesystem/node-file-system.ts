/**
 * FileSystemPort implementation over `node:fs/promises` (SPEC §11.2: Node.js
 * fs API only, never Win32 file APIs directly). Platform errors propagate
 * unchanged (they carry `code`); only `stat` swallows ENOENT into `null`,
 * per the port contract.
 */
import { mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type {
  DirectoryEntry,
  FileStat,
  FileSystemPort,
  MkdirOptions,
  RmOptions,
} from '../../application/ports/file-system.js';

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function createNodeFileSystem(): FileSystemPort {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      return readFile(path);
    },

    async writeFile(path: string, data: Uint8Array): Promise<void> {
      await writeFile(path, data);
    },

    async rename(from: string, to: string): Promise<void> {
      await rename(from, to);
    },

    async mkdir(path: string, options?: MkdirOptions): Promise<void> {
      await mkdir(path, { recursive: options?.recursive ?? false });
    },

    async readdir(path: string): Promise<DirectoryEntry[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async stat(path: string): Promise<FileStat | null> {
      try {
        const info = await stat(path);
        return {
          isFile: info.isFile(),
          isDirectory: info.isDirectory(),
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async realpath(path: string): Promise<string> {
      return realpath(path);
    },

    async unlink(path: string): Promise<void> {
      await unlink(path);
    },

    async rm(path: string, options?: RmOptions): Promise<void> {
      await rm(path, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
    },
  };
}

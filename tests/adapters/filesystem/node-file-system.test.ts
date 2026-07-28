/**
 * Node FileSystemPort adapter against a real temporary directory.
 */
import { mkdtemp, rm as fsRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeFileSystem } from '../../../src/adapters/filesystem/node-file-system.js';
import type { FileSystemPort } from '../../../src/application/ports/file-system.js';

let dir: string;
let fs: FileSystemPort;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apex-fs-'));
  fs = createNodeFileSystem();
});

afterAll(async () => {
  await fsRm(dir, { recursive: true, force: true });
});

describe('node file system', () => {
  it('writes and reads raw bytes', async () => {
    const path = join(dir, 'data.bin');
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    await fs.writeFile(path, bytes);
    expect([...(await fs.readFile(path))]).toEqual([...bytes]);
  });

  it('stats files and directories; returns null for missing paths', async () => {
    const path = join(dir, 'stat-target.txt');
    await fs.writeFile(path, new TextEncoder().encode('hello'));
    const fileStat = await fs.stat(path);
    expect(fileStat).not.toBeNull();
    expect(fileStat!.isFile).toBe(true);
    expect(fileStat!.isDirectory).toBe(false);
    expect(fileStat!.size).toBe(5);
    const dirStat = await fs.stat(dir);
    expect(dirStat!.isDirectory).toBe(true);
    expect(await fs.stat(join(dir, 'missing'))).toBeNull();
  });

  it('creates directories recursively and lists sorted entries', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(join(dir, 'a', 'z.txt'), new Uint8Array());
    await fs.writeFile(join(dir, 'a', 'm.txt'), new Uint8Array());
    const entries = await fs.readdir(join(dir, 'a'));
    expect(entries.map((entry) => entry.name)).toEqual(['b', 'm.txt', 'z.txt']);
    expect(entries[0]!.isDirectory).toBe(true);
    expect(entries[1]!.isFile).toBe(true);
  });

  it('appends to an existing file and creates a missing one', async () => {
    const encoder = new TextEncoder();
    const existing = join(dir, 'append-existing.txt');
    await fs.writeFile(existing, encoder.encode('ab'));
    await fs.appendFile(existing, encoder.encode('cd'));
    expect(new TextDecoder().decode(await fs.readFile(existing))).toBe('abcd');

    const missing = join(dir, 'append-created.txt');
    await fs.appendFile(missing, encoder.encode('xy'));
    expect(new TextDecoder().decode(await fs.readFile(missing))).toBe('xy');
  });

  it('renames over an existing target', async () => {
    const from = join(dir, 'from.txt');
    const to = join(dir, 'to.txt');
    await fs.writeFile(from, new TextEncoder().encode('new'));
    await fs.writeFile(to, new TextEncoder().encode('old'));
    await fs.rename(from, to);
    expect(new TextDecoder().decode(await fs.readFile(to))).toBe('new');
    expect(await fs.stat(from)).toBeNull();
  });

  it('resolves realpath of an existing path', async () => {
    const resolved = await fs.realpath(dir);
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
    expect(await fs.stat(resolved)).not.toBeNull();
  });

  it('unlinks files and removes trees', async () => {
    const file = join(dir, 'gone.txt');
    await fs.writeFile(file, new Uint8Array());
    await fs.unlink(file);
    expect(await fs.stat(file)).toBeNull();

    const tree = join(dir, 'tree');
    await fs.mkdir(join(tree, 'sub'), { recursive: true });
    await fs.writeFile(join(tree, 'sub', 'leaf.txt'), new Uint8Array());
    await fs.rm(tree, { recursive: true });
    expect(await fs.stat(tree)).toBeNull();
  });
});

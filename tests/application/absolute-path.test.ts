/**
 * 跨平台绝对路径规范化与比较的平台矩阵：win32 归一反斜杠并折叠大小写，
 * darwin 默认文件系统同样折叠大小写，linux 区分大小写且保留 `\` 字符。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeAbsolutePath,
  sameAbsolutePath,
} from '../../src/application/absolute-path.js';

describe('normalizeAbsolutePath', () => {
  it('win32: 归一反斜杠、去尾斜杠并保留盘符根', () => {
    expect(normalizeAbsolutePath('C:\\repo\\nested\\', 'win32')).toBe('C:/repo/nested');
    expect(normalizeAbsolutePath('C:\\', 'win32')).toBe('C:/');
    expect(normalizeAbsolutePath('C:/repo/', 'win32')).toBe('C:/repo');
  });

  it('posix: 去尾斜杠、保留文件系统根且不动反斜杠字符', () => {
    expect(normalizeAbsolutePath('/home/user/repo/', 'linux')).toBe('/home/user/repo');
    expect(normalizeAbsolutePath('/', 'linux')).toBe('/');
    expect(normalizeAbsolutePath('/home/we\\ird/name', 'linux')).toBe('/home/we\\ird/name');
    expect(normalizeAbsolutePath('/Users/dev/project', 'darwin')).toBe('/Users/dev/project');
  });
});

describe('sameAbsolutePath', () => {
  it('win32: 大小写不敏感并统一分隔符', () => {
    expect(sameAbsolutePath('C:\\Repo\\Project\\', 'c:/repo/project', 'win32')).toBe(true);
    expect(sameAbsolutePath('C:\\Repo\\One', 'C:\\Repo\\Two', 'win32')).toBe(false);
  });

  it('darwin: 默认文件系统大小写不敏感', () => {
    expect(sameAbsolutePath('/Users/dev/Project/', '/users/dev/project', 'darwin')).toBe(true);
    expect(sameAbsolutePath('/Users/dev/Project', '/Users/dev/Other', 'darwin')).toBe(false);
  });

  it('linux: 区分大小写，尾斜杠与分隔符归一后精确比较', () => {
    expect(sameAbsolutePath('/home/dev/Project/', '/home/dev/Project', 'linux')).toBe(true);
    expect(sameAbsolutePath('/home/dev/Project', '/home/dev/project', 'linux')).toBe(false);
    // `\` 在 Linux 是合法文件名字符，两个不同名字不得被判等。
    expect(sameAbsolutePath('/home/a\\b', '/home/a/b', 'linux')).toBe(false);
  });
});

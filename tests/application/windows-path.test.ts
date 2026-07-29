/**
 * Windows 仓库路径的共享比较规则。
 *
 * 覆盖分隔符、大小写、末尾斜杠与盘符根目录，确保状态发现和 Git 复核使用同一语义。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeAbsoluteWindowsPath,
  sameWindowsPath,
} from '../../src/application/windows-path.js';

describe('Windows path rules', () => {
  it('normalizes separators and trailing slashes without changing a drive root', () => {
    expect(normalizeAbsoluteWindowsPath('C:\\repo\\nested\\')).toBe('C:/repo/nested');
    expect(normalizeAbsoluteWindowsPath('C:\\')).toBe('C:/');
  });

  it('compares paths case-insensitively after normalization', () => {
    expect(sameWindowsPath('C:\\Repo\\Project\\', 'c:/repo/project')).toBe(true);
    expect(sameWindowsPath('C:\\Repo\\One', 'C:\\Repo\\Two')).toBe(false);
  });
});

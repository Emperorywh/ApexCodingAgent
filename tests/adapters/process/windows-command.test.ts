/**
 * Windows 无 Shell 命令解析测试。
 *
 * 全部通过内存环境覆盖 PATH、PATHEXT、npm shim、链式 shim 和拒绝分支，
 * 不读取真实用户环境，也不实际启动批处理文件。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveWindowsCommand,
  type WindowsCommandEnvironment,
} from '../../../src/adapters/process/windows-command.js';

const NPM_PREFIX = 'C:\\nvm\\nodejs';
const REAL_EXE = `${NPM_PREFIX}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const REAL_CLI_JS = `${NPM_PREFIX}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const CMD_SHIM_TO_EXE = [
  '@ECHO off',
  'SETLOCAL',
  '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
  '',
].join('\r\n');
const CMD_SHIM_TO_CLI_JS = [
  '@ECHO off',
  'node "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');
const STANDARD_NPM_NODE_SHIM = [
  '@ECHO off',
  'IF EXIST "%~dp0\\node.exe" (',
  '  SET "_prog=%~dp0\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '"%_prog%" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

interface FakeEnvironmentOptions {
  readonly platform?: string;
  readonly pathVariable?: string;
  readonly pathExtVariable?: string;
  readonly files?: Record<string, string>;
}

/**
 * 使用不区分大小写的内存映射模拟 Windows 文件系统。
 *
 * 空字符串代表存在的可执行文件，非空字符串代表可读取的 shim 内容。
 */
function fakeEnvironment(options: FakeEnvironmentOptions): WindowsCommandEnvironment {
  const files = new Map(
    Object.entries(options.files ?? {}).map(([path, content]) => [path.toLowerCase(), content]),
  );
  return {
    platform: options.platform ?? 'win32',
    pathVariable: options.pathVariable,
    pathExtVariable: options.pathExtVariable,
    fileExists: (absolutePath) => files.has(absolutePath.toLowerCase()),
    readShimText: (absolutePath) => files.get(absolutePath.toLowerCase()) ?? null,
  };
}

describe('resolveWindowsCommand', () => {
  it('leaves commands unchanged outside Windows', () => {
    expect(
      resolveWindowsCommand(
        'claude',
        fakeEnvironment({ platform: 'linux', pathVariable: '/usr/bin' }),
      ),
    ).toBe('claude');
  });

  it('resolves a bare executable in PATH and PATHEXT order', () => {
    const environment = fakeEnvironment({
      pathVariable: 'C:\\tools',
      pathExtVariable: '.EXE;.CMD',
      files: {
        'C:\\tools\\claude.exe': '',
        'C:\\tools\\claude.cmd': CMD_SHIM_TO_EXE,
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe('C:\\tools\\claude.exe');
  });

  it('dereferences npm shims to native and Node script entries', () => {
    const nativeEnvironment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_EXE,
        [REAL_EXE]: '',
      },
    });
    expect(resolveWindowsCommand('claude', nativeEnvironment)).toBe(REAL_EXE);

    const scriptEnvironment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_CLI_JS,
        [REAL_CLI_JS]: '',
      },
    });
    expect(resolveWindowsCommand('claude', scriptEnvironment)).toBe(REAL_CLI_JS);
  });

  it('prefers the CLI script over the node executable in a standard npm shim', () => {
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: STANDARD_NPM_NODE_SHIM,
        [`${NPM_PREFIX}\\node.exe`]: '',
        [REAL_CLI_JS]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(REAL_CLI_JS);
  });

  it('searches quoted PATH entries in order and resolves explicit shims', () => {
    const pathEnvironment = fakeEnvironment({
      pathVariable: ';;"C:\\first";C:\\second;',
      files: { 'C:\\second\\claude.exe': '' },
    });
    expect(resolveWindowsCommand('claude', pathEnvironment)).toBe(
      'C:\\second\\claude.exe',
    );

    const explicitEnvironment = fakeEnvironment({
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_CLI_JS,
        [REAL_CLI_JS]: '',
      },
    });
    expect(
      resolveWindowsCommand(`${NPM_PREFIX}\\claude.cmd`, explicitEnvironment),
    ).toBe(REAL_CLI_JS);
  });

  it('follows a bounded shim chain to a directly executable target', () => {
    const chainExe = 'C:\\chain\\next\\real.exe';
    const environment = fakeEnvironment({
      pathVariable: 'C:\\chain',
      files: {
        'C:\\chain\\claude.cmd': '"%~dp0\\next\\claude.cmd" %*',
        'C:\\chain\\next\\claude.cmd': '"%~dp0\\real.exe" %*',
        [chainExe]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(chainExe);
  });

  it('rejects missing commands, unreadable shims and self-references', () => {
    expect(
      resolveWindowsCommand(
        'claude',
        fakeEnvironment({ pathVariable: 'C:\\empty', files: {} }),
      ),
    ).toBeNull();
    expect(
      resolveWindowsCommand(
        'claude',
        fakeEnvironment({
          pathVariable: NPM_PREFIX,
          files: { [`${NPM_PREFIX}\\claude.cmd`]: '@ECHO off\r\n' },
        }),
      ),
    ).toBeNull();
    expect(
      resolveWindowsCommand(
        'claude',
        fakeEnvironment({
          pathVariable: 'C:\\loop',
          files: { 'C:\\loop\\claude.cmd': '"%~dp0\\claude.cmd" %*' },
        }),
      ),
    ).toBeNull();
  });

  it('rejects an explicit path that does not exist', () => {
    expect(
      resolveWindowsCommand('D:\\missing\\claude.exe', fakeEnvironment({ files: {} })),
    ).toBeNull();
  });

  it('uses default extensions and accepts a bare name with its extension', () => {
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      pathExtVariable: '   ',
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_EXE,
        [REAL_EXE]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(REAL_EXE);
    expect(resolveWindowsCommand('claude.cmd', environment)).toBe(REAL_EXE);
  });
});

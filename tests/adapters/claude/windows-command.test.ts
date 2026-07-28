/**
 * Windows 裸命令名解析测试。全部用内存环境夹具驱动，不触碰真实 PATH；
 * 覆盖 PATHEXT 定位、npm shim 解引用、链式 shim 与各类回退分支。
 */
import { describe, expect, it } from 'vitest';
import {
  resolveWindowsCommand,
  type WindowsCommandEnvironment,
} from '../../../src/adapters/claude/windows-command.js';

const NPM_PREFIX = 'C:\\nvm\\nodejs';
const REAL_EXE = `${NPM_PREFIX}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const REAL_CLI_JS = `${NPM_PREFIX}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

/** npm 新版 shim：批处理变量形式引用原生可执行文件。 */
const CMD_SHIM_TO_EXE = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  '',
].join('\r\n');

/** npm 旧版 shim：通过 node 启动脚本入口。 */
const CMD_SHIM_TO_CLI_JS = [
  '@ECHO off',
  'SETLOCAL',
  'CALL :find_dp0',
  'node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

interface FakeEnvironmentOptions {
  readonly platform?: string;
  readonly pathVariable?: string;
  readonly pathExtVariable?: string;
  /** 规范化绝对路径到文件内容的映射；exe 用空串即可。 */
  readonly files?: Record<string, string>;
}

/** Windows 文件系统不区分大小写，夹具以小写键模拟这一事实。 */
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
  it('returns the command unchanged on non-Windows platforms', () => {
    const environment = fakeEnvironment({ platform: 'linux', pathVariable: '/usr/bin' });
    expect(resolveWindowsCommand('claude', environment)).toBe('claude');
  });

  it('resolves a bare name to an .exe on PATH in PATHEXT order', () => {
    const environment = fakeEnvironment({
      pathVariable: 'C:\\tools',
      pathExtVariable: '.EXE;.CMD',
      files: {
        'C:\\tools\\claude.exe': '',
        'C:\\tools\\claude.cmd': CMD_SHIM_TO_EXE,
        [REAL_EXE]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe('C:\\tools\\claude.exe');
  });

  it('searches PATH directories in order and skips quoted empty segments', () => {
    const environment = fakeEnvironment({
      pathVariable: ';;"C:\\first";C:\\second;',
      files: { 'C:\\second\\claude.exe': '' },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe('C:\\second\\claude.exe');
  });

  it('dereferences an npm .cmd shim to the real executable it wraps', () => {
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_EXE,
        [REAL_EXE]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(REAL_EXE);
  });

  it('dereferences an old-style shim to its script entry for node routing', () => {
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_CLI_JS,
        [REAL_CLI_JS]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(REAL_CLI_JS);
  });

  it('dereferences an explicit .cmd path as well', () => {
    const explicitExe = 'D:\\shims\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const environment = fakeEnvironment({
      files: {
        'D:\\shims\\claude.cmd': CMD_SHIM_TO_EXE,
        [explicitExe]: '',
      },
    });
    expect(resolveWindowsCommand('D:\\shims\\claude.cmd', environment)).toBe(explicitExe);
  });

  it('returns the bare command unchanged when it is not on PATH', () => {
    const environment = fakeEnvironment({ pathVariable: 'C:\\empty', files: {} });
    expect(resolveWindowsCommand('claude', environment)).toBe('claude');
  });

  it('leaves explicit non-shim paths untouched without probing the disk', () => {
    const environment = fakeEnvironment({ files: {} });
    expect(resolveWindowsCommand('D:\\tools\\claude.exe', environment)).toBe(
      'D:\\tools\\claude.exe',
    );
  });

  it('keeps the shim path when its wrapped target does not exist', () => {
    const shim = `${NPM_PREFIX}\\claude.cmd`;
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: { [shim]: CMD_SHIM_TO_EXE },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(shim);
  });

  it('keeps the shim path when no quoted target can be extracted', () => {
    const shim = `${NPM_PREFIX}\\claude.cmd`;
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: { [shim]: '@ECHO off\r\necho nothing useful\r\n' },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(shim);
  });

  it('follows chained shims and terminates on self-references', () => {
    const chainExe = 'C:\\chain\\next\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const chainEnvironment = fakeEnvironment({
      pathVariable: 'C:\\chain',
      files: {
        'C:\\chain\\claude.cmd': '"%~dp0\\next\\claude.cmd" %*',
        'C:\\chain\\next\\claude.cmd': CMD_SHIM_TO_EXE,
        [chainExe]: '',
      },
    });
    expect(resolveWindowsCommand('claude', chainEnvironment)).toBe(chainExe);

    const loopEnvironment = fakeEnvironment({
      pathVariable: 'C:\\loop',
      files: { 'C:\\loop\\claude.cmd': '"%~dp0\\claude.cmd" %*' },
    });
    expect(resolveWindowsCommand('claude', loopEnvironment)).toBe('C:\\loop\\claude.cmd');
  });

  it('uses the default extension list when PATHEXT is missing', () => {
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      pathExtVariable: '   ',
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_EXE,
        [REAL_EXE]: '',
      },
    });
    expect(resolveWindowsCommand('claude', environment)).toBe(REAL_EXE);
  });

  it('resolves a bare name that already carries an extension', () => {
    const environment = fakeEnvironment({
      pathVariable: NPM_PREFIX,
      files: {
        [`${NPM_PREFIX}\\claude.cmd`]: CMD_SHIM_TO_EXE,
        [REAL_EXE]: '',
      },
    });
    expect(resolveWindowsCommand('claude.cmd', environment)).toBe(REAL_EXE);
  });
});

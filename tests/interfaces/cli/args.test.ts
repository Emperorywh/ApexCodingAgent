/**
 * CLI 参数解析单元测试（SPEC §17）：合法形式映射到命令对象；未知命令、
 * 未知选项、多余位置参数、缺值一律 CLI_USAGE_INVALID（退出码 2 的输入）。
 * `abandon` 缺 --force 不在此层拒绝（由用例映射 ABANDON_REQUIRES_FORCE）。
 */
import { describe, expect, it } from 'vitest';
import { ApexError } from '../../../src/domain/errors.js';
import { parseCliArgs, type CliCommand } from '../../../src/interfaces/cli/args.js';

function expectUsageInvalid(argv: readonly string[]): void {
  try {
    parseCliArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(ApexError);
    expect((error as ApexError).errorCode).toBe('CLI_USAGE_INVALID');
    return;
  }
  throw new Error(`expected CLI_USAGE_INVALID for argv: ${argv.join(' ')}`);
}

describe('parseCliArgs (§17)', () => {
  it('parses the documented command forms', () => {
    expect(parseCliArgs(['start'])).toEqual({
      kind: 'start',
      specPath: null,
      fullAccess: false,
      claudeCliPath: null,
      gitCliPath: null,
      pushRemote: null,
      verbose: false,
    });
    expect(
      parseCliArgs([
        'start',
        'docs/SPEC.md',
        '--full-access',
        '--claude-cli-path',
        'C:/tools/claude.exe',
        '--git-cli-path',
        'C:/tools/git.exe',
        '--push-remote',
        'upstream',
      ]),
    ).toEqual({
      kind: 'start',
      specPath: 'docs/SPEC.md',
      fullAccess: true,
      claudeCliPath: 'C:/tools/claude.exe',
      gitCliPath: 'C:/tools/git.exe',
      pushRemote: 'upstream',
      verbose: false,
    });
    expect(parseCliArgs(['start', '--verbose'])).toEqual({
      kind: 'start',
      specPath: null,
      fullAccess: false,
      claudeCliPath: null,
      gitCliPath: null,
      pushRemote: null,
      verbose: true,
    });
    expect(parseCliArgs(['start', '-v'])).toEqual({
      kind: 'start',
      specPath: null,
      fullAccess: false,
      claudeCliPath: null,
      gitCliPath: null,
      pushRemote: null,
      verbose: true,
    });
    expect(parseCliArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseCliArgs(['report'])).toEqual({ kind: 'report' });
    expect(parseCliArgs(['abandon', '--force'])).toEqual({ kind: 'abandon', force: true });
    expect(parseCliArgs(['abandon'])).toEqual({ kind: 'abandon', force: false });
    expect(parseCliArgs(['resume'])).toEqual({
      kind: 'resume',
      fullAccess: false,
      force: false,
      claudeCliPath: null,
      gitCliPath: null,
      verbose: false,
    });
    expect(parseCliArgs(['resume', '--force', '--full-access', '-v'])).toEqual({
      kind: 'resume',
      fullAccess: true,
      force: true,
      claudeCliPath: null,
      gitCliPath: null,
      verbose: true,
    });
  });

  it('maps every help form to the help command', () => {
    const help: CliCommand = { kind: 'help' };
    expect(parseCliArgs(['--help'])).toEqual(help);
    expect(parseCliArgs(['-h'])).toEqual(help);
    expect(parseCliArgs(['help'])).toEqual(help);
    expect(parseCliArgs(['start', '--help'])).toEqual(help);
    expect(parseCliArgs(['status', '-h'])).toEqual(help);
  });

  it('rejects usage errors with CLI_USAGE_INVALID', () => {
    expectUsageInvalid([]);
    expectUsageInvalid(['frobnicate']);
    expectUsageInvalid(['pause']);
    expectUsageInvalid(['stop']);
    expectUsageInvalid(['init']);
    expectUsageInvalid(['resume', 'SPEC.md']); // resume 不接受位置参数
    expectUsageInvalid(['resume', '--nope']);
    expectUsageInvalid(['start', '--nope']);
    expectUsageInvalid(['start', 'a', 'b']); // 最多一个 [spec-path]
    expectUsageInvalid(['start', '--claude-cli-path']); // 缺值
    expectUsageInvalid(['start', '--push-remote']); // 缺值
    expectUsageInvalid(['start', '--full-access=true']); // boolean 选项不接受值
    expectUsageInvalid(['status', 'extra']);
    expectUsageInvalid(['status', '--force']);
    expectUsageInvalid(['report', '--full-access']);
    expectUsageInvalid(['abandon', 'extra']);
  });
});

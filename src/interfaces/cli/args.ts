/**
 * CLI 参数解析（SPEC §17）：`node:util` parseArgs，严格模式，未知命令、
 * 未知选项、多余位置参数一律映射 CLI_USAGE_INVALID（退出码 2）。
 *
 * `abandon` 缺少 --force 不是用法错误：解析放行，由 AbandonRun 用例以
 * ABANDON_REQUIRES_FORCE（command_error，退出码 4）处理。
 */
import { parseArgs } from 'node:util';
import { ApexError } from '../../domain/errors.js';

export type CliCommand =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'start';
      readonly specPath: string | null;
      readonly fullAccess: boolean;
      readonly claudeCliPath: string | null;
      readonly gitCliPath: string | null;
      readonly pushRemote: string | null;
      readonly verbose: boolean;
    }
  | {
      readonly kind: 'resume';
      readonly fullAccess: boolean;
      readonly force: boolean;
      readonly claudeCliPath: string | null;
      readonly gitCliPath: string | null;
      readonly verbose: boolean;
    }
  | { readonly kind: 'status' }
  | { readonly kind: 'report' }
  | { readonly kind: 'abandon'; readonly force: boolean };

function usageInvalid(message: string): ApexError {
  return new ApexError({ code: 'CLI_USAGE_INVALID', stage: 'cli', message });
}

const HELP_OPTION = { type: 'boolean', short: 'h', default: false } as const;

/** 解析失败（未知选项、缺值、意外位置参数等）统一包装为 CLI_USAGE_INVALID。 */
function parseStrict(
  command: string,
  tokens: readonly string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>['options'],
  allowPositionals: boolean,
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: tokens as string[],
      options,
      allowPositionals,
      strict: true,
    });
    return {
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw usageInvalid(`${command}: ${detail}`);
  }
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw usageInvalid('missing command; expected start, resume, status, report or abandon');
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    return { kind: 'help' };
  }

  switch (command) {
    case 'start': {
      const { values, positionals } = parseStrict(
        command,
        rest,
        {
          'full-access': { type: 'boolean', default: false },
          'claude-cli-path': { type: 'string' },
          'git-cli-path': { type: 'string' },
          'push-remote': { type: 'string' },
          verbose: { type: 'boolean', short: 'v', default: false },
          help: HELP_OPTION,
        },
        true,
      );
      if (values['help'] === true) return { kind: 'help' };
      if (positionals.length > 1) {
        throw usageInvalid(`start: expected at most one [spec-path], got ${positionals.length}`);
      }
      return {
        kind: 'start',
        specPath: positionals[0] ?? null,
        fullAccess: values['full-access'] === true,
        claudeCliPath: typeof values['claude-cli-path'] === 'string' ? values['claude-cli-path'] : null,
        gitCliPath: typeof values['git-cli-path'] === 'string' ? values['git-cli-path'] : null,
        pushRemote: typeof values['push-remote'] === 'string' ? values['push-remote'] : null,
        verbose: values['verbose'] === true,
      };
    }
    case 'resume': {
      const { values, positionals } = parseStrict(
        command,
        rest,
        {
          'full-access': { type: 'boolean', default: false },
          force: { type: 'boolean', default: false },
          'claude-cli-path': { type: 'string' },
          'git-cli-path': { type: 'string' },
          verbose: { type: 'boolean', short: 'v', default: false },
          help: HELP_OPTION,
        },
        true,
      );
      if (values['help'] === true) return { kind: 'help' };
      if (positionals.length > 0) {
        throw usageInvalid(`resume: unexpected positional argument ${positionals[0]}`);
      }
      return {
        kind: 'resume',
        fullAccess: values['full-access'] === true,
        force: values['force'] === true,
        claudeCliPath: typeof values['claude-cli-path'] === 'string' ? values['claude-cli-path'] : null,
        gitCliPath: typeof values['git-cli-path'] === 'string' ? values['git-cli-path'] : null,
        verbose: values['verbose'] === true,
      };
    }
    case 'status':
    case 'report': {
      const { values } = parseStrict(command, rest, { help: HELP_OPTION }, false);
      if (values['help'] === true) return { kind: 'help' };
      return { kind: command };
    }
    case 'abandon': {
      const { values } = parseStrict(
        command,
        rest,
        { force: { type: 'boolean', default: false }, help: HELP_OPTION },
        false,
      );
      if (values['help'] === true) return { kind: 'help' };
      return { kind: 'abandon', force: values['force'] === true };
    }
    default:
      throw usageInvalid(
        `unknown command "${command}"; expected start, resume, status, report or abandon`,
      );
  }
}

/**
 * Claude 能力探测实现。版本与公开选项以 `--version` / `--help` 为主证据；
 * 未展示但仍受支持的必需选项通过独立、无 Session 副作用的参数校验确认。
 * 缺少正面证据、证据含糊或不可解析都视为能力缺失，不按版本号猜测能力。
 */
import type { ClaudeCapabilityReport } from '../../application/ports/ClaudeRuntimePort.js';
import { claudeCapabilityMissing, claudeInstallationUnhealthy } from './errors.js';

export interface ProbeRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 通过参数数组运行 CLI。非零退出仍返回原始结果，只有进程完全无法
 * 启动时才拒绝 Promise。
 */
export type ProbeRunner = (args: readonly string[]) => Promise<ProbeRunResult>;

interface ParsedHelpOption {
  readonly aliases: ReadonlySet<string>;
  readonly declarationAndDescription: string;
}

type HelpOptionCatalog = ReadonlyMap<string, ParsedHelpOption | null>;

interface CapabilityCheck {
  readonly id: string;
  readonly present: (catalog: HelpOptionCatalog) => boolean;
}

/**
 * 只解析真实的长选项声明行，并把紧随其后的缩进续行并入描述。相同别名
 * 出现多次会标记为含糊，后续能力检查按缺失处理。
 * 值占位符同时接受必选 `<value>` 与可选 `[value]` 两种语法（真实 CLI
 * 的 `-r, --resume [value]` 使用后者）。
 */
function parseHelpOptions(helpText: string): HelpOptionCatalog {
  const catalog = new Map<string, ParsedHelpOption | null>();
  const lines = helpText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match =
      /^\s*((?:-[A-Za-z0-9],\s*)?--[A-Za-z0-9-]+(?:\s+<[^>\r\n]+>|\s+\[[^\]\r\n]+\])?)(?:\s{2,}|\t+)(.*)$/.exec(
        line,
      );
    if (match === null) continue;

    const declaration = match[1] ?? '';
    const aliases = new Set(declaration.match(/-{1,2}[A-Za-z0-9-]+/g) ?? []);
    const descriptionParts = [declaration, match[2] ?? ''];
    for (let continuation = index + 1; continuation < lines.length; continuation += 1) {
      const next = lines[continuation] ?? '';
      if (next.trim() === '' || /^\s*(?:-[A-Za-z0-9],\s*)?--[A-Za-z0-9-]+\b/.test(next)) {
        break;
      }
      if (!/^\s{4,}\S/.test(next)) break;
      descriptionParts.push(next.trim());
      index = continuation;
    }

    const option: ParsedHelpOption = {
      aliases,
      declarationAndDescription: descriptionParts.join(' '),
    };
    for (const alias of aliases) {
      catalog.set(alias, catalog.has(alias) ? null : option);
    }
  }
  return catalog;
}

function optionExplicitlyContains(
  catalog: HelpOptionCatalog,
  optionName: string,
  value: string,
): boolean {
  const option = catalog.get(optionName);
  if (option === undefined || option === null) return false;
  return new RegExp(`\\b${value}\\b`).test(option.declarationAndDescription);
}

/**
 * SPEC §8.1 第 5 项要求的能力（含 resume 续接、Task 回合预算与会话级
 * 设置覆盖）。设置覆盖用于固定结构化输出的工具加载协议，不能等到正式
 * Session 启动后才发现当前 Claude CLI 不支持该边界。
 */
export const REQUIRED_CAPABILITIES: readonly CapabilityCheck[] = [
  {
    id: 'print-mode',
    present: (catalog) => catalog.get('--print')?.aliases.has('-p') === true,
  },
  {
    id: 'stream-json',
    present: (catalog) => optionExplicitlyContains(catalog, '--output-format', 'stream-json'),
  },
  {
    id: 'json-schema',
    present: (catalog) => {
      const option = catalog.get('--json-schema');
      return option !== undefined && option !== null;
    },
  },
  {
    id: 'max-turns',
    present: (catalog) => {
      const option = catalog.get('--max-turns');
      return option !== undefined && option !== null;
    },
  },
  {
    id: 'settings-override',
    present: (catalog) => {
      const option = catalog.get('--settings');
      return option !== undefined && option !== null;
    },
  },
  {
    id: 'session-id',
    present: (catalog) => {
      const option = catalog.get('--session-id');
      return option !== undefined && option !== null;
    },
  },
  {
    id: 'session-resume',
    present: (catalog) => catalog.get('--resume')?.aliases.has('-r') === true,
  },
  {
    id: 'fork-session',
    present: (catalog) => {
      const option = catalog.get('--fork-session');
      return option !== undefined && option !== null;
    },
  },
  {
    id: 'permission-mode plan',
    present: (catalog) => optionExplicitlyContains(catalog, '--permission-mode', 'plan'),
  },
  {
    id: 'permission-mode auto',
    present: (catalog) => optionExplicitlyContains(catalog, '--permission-mode', 'auto'),
  },
  {
    id: 'permission-mode bypassPermissions',
    present: (catalog) =>
      optionExplicitlyContains(catalog, '--permission-mode', 'bypassPermissions'),
  },
];

export interface CapabilityParse {
  readonly found: readonly string[];
  readonly missing: readonly string[];
}

/** 对 help 文本执行纯解析，由固定 Fixture 驱动全部分支。 */
export function parseCapabilityHelp(helpText: string): CapabilityParse {
  const catalog = parseHelpOptions(helpText);
  const found: string[] = [];
  const missing: string[] = [];
  for (const check of REQUIRED_CAPABILITIES) {
    (check.present(catalog) ? found : missing).push(check.id);
  }
  return { found, missing };
}

interface BehavioralCapabilityProbe {
  readonly id: string;
  readonly args: readonly string[];
  readonly confirms: (result: ProbeRunResult) => boolean;
}

const MAX_TURNS_INVALID_VALUE = 'apex-max-turns-capability-check';

/**
 * Claude Code 2.1.220 仍接受 --max-turns，但不再把它展示在顶层 help 中。
 * 这里故意提交非数字值并同时请求 help：已注册的选项会先执行数值校验，
 * 未注册的选项则不会产生包含该值的数值诊断，全程不会创建 Session 或访问网络。
 */
const BEHAVIORAL_CAPABILITY_PROBES: readonly BehavioralCapabilityProbe[] = [
  {
    id: 'max-turns',
    args: ['--max-turns', MAX_TURNS_INVALID_VALUE, '--help'],
    confirms: (result) => {
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      return (
        result.code !== 0 &&
        diagnostic.includes('--max-turns') &&
        diagnostic.includes(MAX_TURNS_INVALID_VALUE) &&
        /\b(?:invalid|number|integer)\b/i.test(diagnostic) &&
        !/\bunknown option\b/i.test(diagnostic)
      );
    },
  },
];

/**
 * help 文本仍是公开能力的首要证据；只有 help 未声明、但存在独立行为探针的
 * 能力才会进入第二阶段。结果最终按 REQUIRED_CAPABILITIES 的稳定顺序重建，
 * 使调用方不需要理解某项能力来自静态声明还是无副作用的参数校验。
 */
async function resolveCapabilityEvidence(
  run: ProbeRunner,
  helpParse: CapabilityParse,
): Promise<CapabilityParse> {
  const confirmed = new Set(helpParse.found);
  const pendingProbes = BEHAVIORAL_CAPABILITY_PROBES.filter((probe) =>
    helpParse.missing.includes(probe.id),
  );

  await Promise.all(
    pendingProbes.map(async (probe) => {
      try {
        if (probe.confirms(await run(probe.args))) confirmed.add(probe.id);
      } catch {
        /*
         * 行为探针无法执行就是缺少正面能力证据；统一留给下方缺失能力错误，
         * 不在 Adapter 内引入版本猜测或静默放行路径。
         */
      }
    }),
  );

  const found = REQUIRED_CAPABILITIES.map((check) => check.id).filter((id) =>
    confirmed.has(id),
  );
  const missing = REQUIRED_CAPABILITIES.map((check) => check.id).filter(
    (id) => !confirmed.has(id),
  );
  return { found, missing };
}

export interface CapabilityProbe {
  /** 执行完整能力检查，发现任一缺失即抛出稳定错误。 */
  probeCapabilities(): Promise<ClaudeCapabilityReport>;
  /**
   * 返回去除首尾空白的版本；启动失败、非零退出或空输出都返回 null，
   * 由调用方根据所在阶段决定错误映射。
   */
  readVersion(): Promise<string | null>;
}

interface VersionProbeOutcome {
  readonly version: string | null;
  /** version 为 null 时的底层原因，进入错误 detail 供启动诊断。 */
  readonly failure: string | null;
}

export function createCapabilityProbe(
  run: ProbeRunner,
  redact: (text: string) => string,
): CapabilityProbe {
  async function readVersionOutcome(): Promise<VersionProbeOutcome> {
    let result: ProbeRunResult;
    try {
      result = await run(['--version']);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      /*
       * 启动异常和探测 stderr 都来自外部进程，必须在组装错误事实前脱敏；
       * CapabilityProbe 返回的任何动态字符串因而都可以安全离开 Adapter。
       */
      return { version: null, failure: `could not be started (${redact(reason)})` };
    }
    if (result.code !== 0) {
      const firstStderrLine = result.stderr.split(/\r?\n/, 1)[0]?.trim() ?? '';
      const suffix =
        firstStderrLine === '' ? '' : `: ${redact(firstStderrLine).slice(0, 160)}`;
      return { version: null, failure: `exited with code ${result.code}${suffix}` };
    }
    const version = redact(result.stdout.trim());
    return version === ''
      ? { version: null, failure: 'produced no version output' }
      : { version, failure: null };
  }

  async function readVersion(): Promise<string | null> {
    return (await readVersionOutcome()).version;
  }

  async function probeCapabilities(): Promise<ClaudeCapabilityReport> {
    const outcome = await readVersionOutcome();
    if (outcome.version === null) {
      throw claudeInstallationUnhealthy(`claude --version ${outcome.failure ?? 'failed'}`);
    }
    const version = outcome.version;
    let help: ProbeRunResult;
    try {
      help = await run(['--help']);
    } catch (error) {
      throw claudeCapabilityMissing(
        REQUIRED_CAPABILITIES.map((check) => check.id),
        version,
        { detail: 'claude --help could not be executed', cause: error },
      );
    }
    if (help.code !== 0 || help.stdout.trim() === '') {
      throw claudeCapabilityMissing(
        REQUIRED_CAPABILITIES.map((check) => check.id),
        version,
        { detail: `claude --help exited with code ${help.code} or produced no output` },
      );
    }
    const { found, missing } = await resolveCapabilityEvidence(
      run,
      parseCapabilityHelp(help.stdout),
    );
    if (missing.length > 0) {
      throw claudeCapabilityMissing(missing, version);
    }
    return { version, capabilities: found };
  }

  return { probeCapabilities, readVersion };
}

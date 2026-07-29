/**
 * start / resume 共用的运行时前置检查。
 *
 * 本模块只编排可复用的端口操作，不决定命令资格或状态迁移：状态目录
 * 可写探测和 Claude 能力探测在两个前台命令中保持完全一致。
 */
import { ApexError } from '../../domain/errors.js';
import type {
  ClaudeCapabilityReport,
  ClaudeRuntimePort,
} from '../ports/ClaudeRuntimePort.js';
import type { FileSystemPort } from '../ports/file-system.js';
import type { LoggerPort } from '../ports/logger.js';
import type { OutputPort } from '../ports/output.js';
import type { RedactionPort } from '../ports/redaction.js';

/** 前台 Run 命令的环境事实，由 Composition Root 采集并显式注入。 */
export interface EnvironmentFacts {
  /** Node `process.platform`，Windows 为 `win32`。 */
  readonly platform: string;
  /** Node `os.release()`，如 `10.0.22631`。 */
  readonly release: string;
  /** Node `process.version`，如 `v22.11.0`。 */
  readonly nodeVersion: string;
  /** ApexCodingAgent 自身版本，取自安装清单 package.json（读取失败为 `unknown`）。 */
  readonly agentVersion: string;
}

/** §8.1 第 1、3 项：Windows 版本与 Node Runtime 受支持。 */
export function assertEnvironmentSupported(environment: EnvironmentFacts): void {
  if (environment.platform !== 'win32') {
    throw new ApexError({
      code: 'ENVIRONMENT_UNSUPPORTED',
      stage: 'startup',
      message: `unsupported platform ${environment.platform}; only Windows is supported`,
    });
  }
  const releaseMajor = Number.parseInt(environment.release.split('.')[0] ?? '', 10);
  if (!Number.isInteger(releaseMajor) || releaseMajor < 10) {
    throw new ApexError({
      code: 'ENVIRONMENT_UNSUPPORTED',
      stage: 'startup',
      message: `unsupported Windows release ${environment.release}; Windows 10 or later is required`,
    });
  }
  const nodeMajor = Number.parseInt(
    environment.nodeVersion.replace(/^v/, '').split('.')[0] ?? '',
    10,
  );
  if (nodeMajor !== 22 && nodeMajor !== 24) {
    throw new ApexError({
      code: 'ENVIRONMENT_UNSUPPORTED',
      stage: 'startup',
      message:
        `unsupported Node.js version ${environment.nodeVersion}; ` +
        'requires >=22 <23 || >=24 <25',
    });
  }
}

/** 通过同目录临时文件验证状态目录可创建且可写。 */
export async function assertStateDirectoryWritable(
  fileSystem: FileSystemPort,
  stateDir: string,
): Promise<void> {
  try {
    await fileSystem.mkdir(stateDir, { recursive: true });
    const probe = `${stateDir}/.write-probe-${globalThis.crypto.randomUUID()}`;
    await fileSystem.writeFile(probe, new Uint8Array(0));
    await fileSystem.unlink(probe);
  } catch (error) {
    throw new ApexError({
      code: 'STATE_DIRECTORY_UNWRITABLE',
      stage: 'startup',
      message: `state directory ${stateDir} is not creatable/writable`,
      cause: error,
    });
  }
}

/**
 * 启动横幅第一项：ApexCodingAgent 自身版本。
 *
 * 在任何前置校验之前输出，即使启动因环境门禁失败，排障时也能拿到
 * 确切的安装版本。模型与 Provider 属于 Session 事实，只能在首个
 * Session 的 system/init 事件到达后由 Session 进度行输出，不在此伪造。
 */
export function reportApexVersion(
  output: OutputPort,
  redaction: RedactionPort,
  agentVersion: string,
): void {
  output.writeLine(redaction.redactText(`[apex] ApexCodingAgent version: ${agentVersion}`));
}

/** 有界探测 Claude 版本与九项命令能力，并记录统一诊断事件。 */
export async function probeClaudeCapabilities(
  claude: ClaudeRuntimePort,
  output: OutputPort,
  redaction: RedactionPort,
  logger: LoggerPort,
  eventPrefix: 'startup' | 'resume',
  claudeCliPath: string | null,
): Promise<ClaudeCapabilityReport> {
  output.writeLine('[apex] probing claude CLI capabilities (bounded 30s x2)...');
  logger.log('debug', `${eventPrefix}.probe.begin`, {
    claudePath: claudeCliPath ?? 'claude',
  });
  const report = await claude.probeCapabilities();
  // 版本来自 `claude --version` 输出，属动态内容，打印前过统一脱敏边界。
  output.writeLine(
    redaction.redactText(
      `[apex] claude version: ${report.version} (${report.capabilities.length} capabilities confirmed)`,
    ),
  );
  logger.log('debug', `${eventPrefix}.probe.end`, {
    version: report.version,
    capabilities: report.capabilities.join(','),
  });
  return report;
}

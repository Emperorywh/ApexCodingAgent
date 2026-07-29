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

/** 前台 Run 命令的环境事实，由 Composition Root 采集并显式注入。 */
export interface EnvironmentFacts {
  /** Node `process.platform`，Windows 为 `win32`。 */
  readonly platform: string;
  /** Node `os.release()`，如 `10.0.22631`。 */
  readonly release: string;
  /** Node `process.version`，如 `v22.11.0`。 */
  readonly nodeVersion: string;
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

/** 有界探测 Claude 版本与九项命令能力，并记录统一诊断事件。 */
export async function probeClaudeCapabilities(
  claude: ClaudeRuntimePort,
  output: OutputPort,
  logger: LoggerPort,
  eventPrefix: 'startup' | 'resume',
  claudeCliPath: string | null,
): Promise<ClaudeCapabilityReport> {
  output.writeLine('[apex] probing claude CLI capabilities (bounded 30s x2)...');
  logger.log('debug', `${eventPrefix}.probe.begin`, {
    claudePath: claudeCliPath ?? 'claude',
  });
  const report = await claude.probeCapabilities();
  logger.log('debug', `${eventPrefix}.probe.end`, {
    version: report.version,
    capabilities: report.capabilities.join(','),
  });
  return report;
}

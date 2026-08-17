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
import {
  renderClaudeProbeCompleted,
  renderClaudeProbeStarted,
} from '../presentation/progress.js';

/** 前台 Run 命令的环境事实，由 Composition Root 采集并显式注入。 */
export interface EnvironmentFacts {
  /** Node `process.platform`：Windows 为 `win32`，macOS 为 `darwin`，Linux 为 `linux`。 */
  readonly platform: string;
  /** Node `os.release()`，Windows 如 `10.0.22631`，Unix 为内核/Darwin 版本。 */
  readonly release: string;
  /** Node `process.version`，如 `v22.11.0`。 */
  readonly nodeVersion: string;
  /** ApexCodingAgent 自身版本，取自安装清单 package.json（读取失败为 `unknown`）。 */
  readonly agentVersion: string;
}

/**
 * 受支持平台白名单，与 package.json 的 `os` 字段保持一致。
 *
 * Windows 外的平台不按 `os.release()` 做版本门禁：Unix 的 release 是内核
 * 版本而非产品版本，且 Node 自身的 engines 约束已经覆盖运行环境要求。
 */
const SUPPORTED_PLATFORMS: readonly string[] = ['win32', 'darwin', 'linux'];

/** §8.1 第 1、3 项：操作系统平台（Windows 版本）与 Node Runtime 受支持。 */
export function assertEnvironmentSupported(environment: EnvironmentFacts): void {
  if (!SUPPORTED_PLATFORMS.includes(environment.platform)) {
    throw new ApexError({
      code: 'ENVIRONMENT_UNSUPPORTED',
      stage: 'startup',
      message:
        `unsupported platform ${environment.platform}; ` +
        'supported platforms are Windows, macOS and Linux',
    });
  }
  if (environment.platform === 'win32') {
    const releaseMajor = Number.parseInt(environment.release.split('.')[0] ?? '', 10);
    if (!Number.isInteger(releaseMajor) || releaseMajor < 10) {
      throw new ApexError({
        code: 'ENVIRONMENT_UNSUPPORTED',
        stage: 'startup',
        message: `unsupported Windows release ${environment.release}; Windows 10 or later is required`,
      });
    }
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
 * 有界探测 Claude 版本与十项命令能力，并记录统一诊断事件；具体能力证据
 * 由 Claude Adapter 解释，本用例只编排端口并输出已脱敏的稳定事实。
 */
export async function probeClaudeCapabilities(
  claude: ClaudeRuntimePort,
  output: OutputPort,
  redaction: RedactionPort,
  logger: LoggerPort,
  eventPrefix: 'startup' | 'resume',
  claudeCliPath: string | null,
): Promise<ClaudeCapabilityReport> {
  output.writeLine(renderClaudeProbeStarted());
  logger.log('debug', `${eventPrefix}.probe.begin`, {
    claudePath: claudeCliPath ?? 'claude',
  });
  const report = await claude.probeCapabilities();
  // 版本来自 `claude --version` 输出，属动态内容，打印前过统一脱敏边界。
  output.writeLine(
    redaction.redactText(
      renderClaudeProbeCompleted(report.version, report.capabilities.length),
    ),
  );
  logger.log('debug', `${eventPrefix}.probe.end`, {
    version: report.version,
    capabilities: report.capabilities.join(','),
  });
  return report;
}

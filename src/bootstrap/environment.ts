/**
 * 启动环境事实采集（SPEC §8.1 第 1、3 项）：平台、Windows 版本、Node
 * 版本，以及 ApexCodingAgent 自身版本（启动横幅使用）。判断逻辑在
 * Application 的共享 Run 前置检查中（ENVIRONMENT_UNSUPPORTED，不隐式
 * 兼容）；本模块只负责从进程与安装清单读取事实，可注入来源便于测试
 * 替换。
 */
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import type { EnvironmentFacts } from '../application/usecases/run-runtime-preflight.js';

export interface EnvironmentSource {
  readonly platform: string;
  readonly release: string;
  readonly nodeVersion: string;
}

const PROCESS_SOURCE: EnvironmentSource = {
  platform: process.platform,
  release: release(),
  nodeVersion: process.version,
};

/**
 * 从自身 package.json 读取 ApexCodingAgent 版本。
 *
 * 模块位于 <root>/src|dist/bootstrap/，两级上溯均为包根，源码运行
 * （vitest）与构建产物（dist）路径一致；npm 包始终携带 package.json。
 * 清单缺失或损坏不得阻断任何命令（含 status/report 等只读命令），
 * 横幅降级为 `unknown`。
 */
function readAgentVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      const version = (manifest as { readonly version: unknown }).version;
      if (typeof version === 'string' && version !== '') return version;
    }
  } catch {
    // 见上方注释：安装清单不可读时降级，不抛错。
  }
  return 'unknown';
}

export function collectEnvironmentFacts(
  source: EnvironmentSource = PROCESS_SOURCE,
): EnvironmentFacts {
  return {
    platform: source.platform,
    release: source.release,
    nodeVersion: source.nodeVersion,
    agentVersion: readAgentVersion(),
  };
}

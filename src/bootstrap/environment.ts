/**
 * 启动环境事实采集（SPEC §8.1 第 1、3 项）：平台、Windows 版本、Node
 * 版本。判断逻辑在 Application 的 StartRun 用例（ENVIRONMENT_UNSUPPORTED，
 * 不隐式兼容）；本模块只负责从进程读取事实，可注入来源便于测试替换。
 */
import { release } from 'node:os';
import type { EnvironmentFacts } from '../application/usecases/start-run.js';

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

export function collectEnvironmentFacts(
  source: EnvironmentSource = PROCESS_SOURCE,
): EnvironmentFacts {
  return {
    platform: source.platform,
    release: source.release,
    nodeVersion: source.nodeVersion,
  };
}

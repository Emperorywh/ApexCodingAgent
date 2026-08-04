/**
 * 测试装配使用的进程执行器工厂。
 *
 * 每个 Adapter 夹具显式获得独立执行器，保持生产组合根相同的依赖方向，
 * 同时避免测试通过隐藏默认值绕过 Execa 边界。
 */

import { createExecaProcessExecutor } from '../src/adapters/process/execa-process-executor.js';
import type { ProcessExecutor } from '../src/adapters/process/process-executor.js';

export function createTestProcessExecutor(
  environmentOverrides: Readonly<Record<string, string>> = {},
): ProcessExecutor {
  /**
   * 测试专属环境随执行器实例显式注入，不能通过 process.env 暗中共享。
   * 该工厂仍返回真实 Execa 实现，不改变任何进程、标准流或超时语义。
   */
  return createExecaProcessExecutor({ environmentOverrides });
}

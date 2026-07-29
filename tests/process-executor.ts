/**
 * 测试装配使用的进程执行器工厂。
 *
 * 每个 Adapter 夹具显式获得独立执行器，保持生产组合根相同的依赖方向，
 * 同时避免测试通过隐藏默认值绕过 Execa 边界。
 */

import { createExecaProcessExecutor } from '../src/adapters/process/execa-process-executor.js';
import type { ProcessExecutor } from '../src/adapters/process/process-executor.js';

export function createTestProcessExecutor(): ProcessExecutor {
  return createExecaProcessExecutor();
}

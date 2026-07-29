/**
 * Windows 无 Shell 命令解析器。
 *
 * Node 与 Execa 在执行 .cmd/.bat 时都可能转交 cmd.exe；本项目要求底层
 * 进程始终是参数数组且不经过 Shell，因此必须先把 PATH 上的 shim 解析
 * 到真实 .exe 或 Node 脚本。无法证明可直接执行时返回 null，禁止隐式
 * 降级为批处理执行。
 */

import { dirname, isAbsolute, normalize, resolve as resolvePath } from 'node:path';

export interface WindowsCommandEnvironment {
  readonly platform: string;
  readonly pathVariable: string | undefined;
  readonly pathExtVariable: string | undefined;
  readonly fileExists: (absolutePath: string) => boolean;
  readonly readShimText: (absolutePath: string) => string | null;
}

const DEFAULT_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const BATCH_SHIM_PATTERN = /\.(?:cmd|bat)$/i;
const EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/;
const SHIM_TARGET_PATTERN = /["']([^"'\r\n]+?\.(?:com|exe|cmd|bat|js|cjs|mjs))["']/gi;
const SHIM_DIR_TOKEN_PATTERN = /%~dp0|%dp0%/gi;
const MAX_SHIM_CHAIN_DEPTH = 3;

function hasPathSeparator(command: string): boolean {
  return /[\\/]/.test(command);
}

function pathExtensions(environment: WindowsCommandEnvironment): readonly string[] {
  const raw = environment.pathExtVariable?.trim() ?? '';
  if (raw === '') return DEFAULT_PATH_EXTENSIONS;
  const extensions = raw
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  return extensions.length === 0 ? DEFAULT_PATH_EXTENSIONS : extensions;
}

/**
 * 按 Windows PATH 与 PATHEXT 顺序定位真实文件。
 *
 * 显式路径同样必须存在，避免把不存在的路径交给 Execa 后触发其批处理
 * 兼容路径。
 */
function findCommand(
  command: string,
  environment: WindowsCommandEnvironment,
): string | null {
  if (hasPathSeparator(command)) {
    const candidate = normalize(command);
    return environment.fileExists(candidate) ? candidate : null;
  }
  if (environment.pathVariable === undefined) return null;
  const directories = environment.pathVariable
    .split(';')
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ''))
    .filter((entry) => entry !== '');
  const extensions = EXTENSION_PATTERN.test(command) ? [''] : pathExtensions(environment);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = normalize(`${directory}\\${command}${extension}`);
      if (environment.fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 从 npm shim 中提取引号包裹的真实入口。
 *
 * 仅接受已经存在的 exe、批处理或 Node 脚本目标；链式批处理会继续解析，
 * 最终仍停留在批处理文件时由顶层解析器拒绝。
 */
function extractShimTarget(
  shimPath: string,
  environment: WindowsCommandEnvironment,
): string | null {
  const text = environment.readShimText(shimPath);
  if (text === null) return null;
  const shimDirectory = dirname(shimPath);
  const targets = [...text.matchAll(SHIM_TARGET_PATTERN)]
    .map((match) => match[1])
    .filter((target): target is string => target !== undefined)
    .map((target) => target.replace(SHIM_DIR_TOKEN_PATTERN, `${shimDirectory}\\`))
    .map((target) => isAbsolute(target) ? normalize(target) : resolvePath(shimDirectory, target))
    .filter((target) => environment.fileExists(target));

  /**
   * 标准 npm Node shim 会同时引用 node.exe 和真正的 JavaScript 入口。
   *
   * JavaScript 入口包含完整 CLI 身份，必须优先于仅作为解释器的 node.exe；
   * 其余 shim 再依次选择原生入口和链式批处理目标。
   */
  const priority = (target: string): number => {
    if (/\.(?:cjs|js|mjs)$/i.test(target)) return 0;
    if (/\.(?:com|exe)$/i.test(target)) return 1;
    return 2;
  };
  return targets.sort((left, right) => priority(left) - priority(right))[0] ?? null;
}

/**
 * 返回可以直接无 Shell 启动的入口；无法解析时返回 null。
 *
 * 非 Windows 系统由操作系统原生完成命令发现，因此保持调用方输入不变。
 */
export function resolveWindowsCommand(
  command: string,
  environment: WindowsCommandEnvironment,
): string | null {
  if (environment.platform !== 'win32') return command;
  let candidate = findCommand(command, environment);
  if (candidate === null) return null;
  for (
    let depth = 0;
    depth < MAX_SHIM_CHAIN_DEPTH && BATCH_SHIM_PATTERN.test(candidate);
    depth += 1
  ) {
    const target = extractShimTarget(candidate, environment);
    if (target === null || target === candidate) return null;
    candidate = target;
  }
  return BATCH_SHIM_PATTERN.test(candidate) ? null : candidate;
}

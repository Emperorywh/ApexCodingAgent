/**
 * Windows 裸命令名解析。npm 全局安装的 Claude Code 只在 PATH 上放置
 * `claude.cmd` / `claude.ps1` 与无扩展名 shim；`spawn(..., { shell: false })`
 * 按字面可执行文件查找，既解析不到 shim（ENOENT），也被 Node 拒绝直接
 * 启动批处理文件，最终会被误报为 CLAUDE_INSTALLATION_UNHEALTHY。
 *
 * 本模块把裸命令名解析为可以无 Shell 启动的真实入口：按 PATHEXT 顺序
 * 在 PATH 中定位，命中 .cmd/.bat shim 时读出其中引号包裹的真实目标
 * （.exe 或脚本文件）。脚本目标仍由 resolveCommand 交给当前 Node 运行
 * 时启动，全程不经过 Shell。
 */

import { dirname, isAbsolute, normalize, resolve as resolvePath } from 'node:path';

/** 可注入的环境事实，便于用内存夹具驱动全部分支。 */
export interface WindowsCommandEnvironment {
  readonly platform: string;
  readonly pathVariable: string | undefined;
  readonly pathExtVariable: string | undefined;
  readonly fileExists: (absolutePath: string) => boolean;
  /** 读取 shim 文本；文件不可读时返回 null。 */
  readonly readShimText: (absolutePath: string) => string | null;
}

/**
 * PATHEXT 惯例为大写；统一按小写构造候选路径不影响匹配（Windows 文件
 * 系统不区分大小写），且更贴近 npm shim 的实际小写命名。
 */
const DEFAULT_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const BATCH_SHIM_PATTERN = /\.(?:cmd|bat)$/i;
const EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/;
const SHIM_TARGET_PATTERN = /["']([^"'\r\n]+?\.(?:exe|cmd|bat|js|cjs|mjs))["']/i;
/** npm shim 里代表 shim 所在目录的两种变量写法（自带尾部反斜杠）。 */
const SHIM_DIR_TOKEN_PATTERN = /%~dp0|%dp0%/gi;
/** shim 链式引用时的最大解引用深度，防止循环引用无限展开。 */
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

/** 按 PATHEXT 顺序在 PATH 目录中定位命令；找不到返回 null。 */
function findOnPath(command: string, environment: WindowsCommandEnvironment): string | null {
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
 * 从 shim 文本提取第一个引号包裹、以可执行后缀结尾的目标路径，展开
 * 目录变量并确认其真实存在；任一环节失败都返回 null。
 */
function extractShimTarget(
  shimPath: string,
  environment: WindowsCommandEnvironment,
): string | null {
  const text = environment.readShimText(shimPath);
  if (text === null) return null;
  const match = SHIM_TARGET_PATTERN.exec(text);
  if (match === null || match[1] === undefined) return null;
  const shimDirectory = dirname(shimPath);
  const expanded = match[1].replace(SHIM_DIR_TOKEN_PATTERN, `${shimDirectory}\\`);
  const target = isAbsolute(expanded) ? normalize(expanded) : resolvePath(shimDirectory, expanded);
  return environment.fileExists(target) ? target : null;
}

/**
 * 把（可能是裸命令名的）入口解析为可直接 spawn 的路径。解析不到真实
 * 入口时原样返回，让底层 spawn 错误按既有路径暴露。
 */
export function resolveWindowsCommand(
  command: string,
  environment: WindowsCommandEnvironment,
): string {
  if (environment.platform !== 'win32') return command;
  let candidate = hasPathSeparator(command)
    ? command
    : (findOnPath(command, environment) ?? command);
  for (
    let depth = 0;
    depth < MAX_SHIM_CHAIN_DEPTH && BATCH_SHIM_PATTERN.test(candidate);
    depth += 1
  ) {
    const target = extractShimTarget(candidate, environment);
    if (target === null || target === candidate) break;
    candidate = target;
  }
  return candidate;
}

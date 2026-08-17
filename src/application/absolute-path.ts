/**
 * 应用层共享的跨平台绝对路径规范化与比较规则。
 *
 * 这里只做纯字符串规范化，不访问文件系统，也不推断真实路径；调用方必须先通过
 * FileSystemPort 或 GitPort 获取可信的绝对路径，再使用该规则比较仓库边界。
 * 平台差异：
 * - win32：`\` 是目录分隔符，统一归一为 `/`，盘符根 `C:/` 保留，比较折叠大小写；
 * - darwin：默认文件系统（HFS+/APFS）不区分大小写，比较同样折叠大小写；
 * - linux 及其他平台：`\` 是合法文件名字符须原样保留，比较区分大小写。
 */
export function normalizeAbsolutePath(path: string, platform: string): string {
  if (platform === 'win32') {
    const normalized = path.replace(/\\/g, '/');
    return /^[A-Za-z]:\/$/.test(normalized)
      ? normalized
      : normalized.replace(/\/+$/, '');
  }
  return path === '/' ? '/' : path.replace(/\/+$/, '');
}

/**
 * 仓库边界比较：统一目录分隔符与末尾斜杠后，按平台决定是否折叠大小写。
 *
 * 集中该规则可避免状态发现、Git 复核等用例各自维护略有差异的边界判断。
 */
export function sameAbsolutePath(left: string, right: string, platform: string): boolean {
  const normalizedLeft = normalizeAbsolutePath(left, platform);
  const normalizedRight = normalizeAbsolutePath(right, platform);
  if (platform === 'win32' || platform === 'darwin') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

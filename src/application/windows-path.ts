/**
 * 应用层共享的 Windows 绝对路径比较规则。
 *
 * 这里只做纯字符串规范化，不访问文件系统，也不推断真实路径；调用方必须先通过
 * FileSystemPort 或 GitPort 获取可信的绝对路径，再使用该规则比较仓库边界。
 */
export function normalizeAbsoluteWindowsPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return /^[A-Za-z]:\/$/.test(normalized)
    ? normalized
    : normalized.replace(/\/+$/, '');
}

/**
 * Windows 路径比较不区分大小写，并统一目录分隔符与末尾斜杠。
 *
 * 集中该规则可避免状态发现、Git 复核等用例各自维护略有差异的边界判断。
 */
export function sameWindowsPath(left: string, right: string): boolean {
  return normalizeAbsoluteWindowsPath(left).toLowerCase() ===
    normalizeAbsoluteWindowsPath(right).toLowerCase();
}

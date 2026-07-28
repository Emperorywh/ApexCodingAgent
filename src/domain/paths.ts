/**
 * Git 相对路径值对象校验。
 *
 * 项目内路径必须使用正斜杠，且不能是绝对路径、盘符路径或包含
 * `.` / `..` 段。该纯函数同时供 JSON Schema 与文件访问边界复用，
 * 避免持久化契约和运行时路径校验产生两套规则。
 */
export function isGitRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;

  const segments = value.split('/');
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

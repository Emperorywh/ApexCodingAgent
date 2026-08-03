/**
 * Git 相对路径的可序列化语法约束。
 *
 * 该正则既是领域值对象的唯一语法来源，也会作为标准 JSON Schema
 * `pattern` 交给外部结构化输出生成器。这样外部边界无需理解自定义
 * `git-relative-path` format，也能拒绝反斜杠、盘符、空路径段、`.` / `..`
 * 路径段以及以 `/` 结尾的目录写法。
 */
export const GIT_RELATIVE_PATH_PATTERN =
  /^(?![A-Za-z]:)(?:(?!\.{1,2}(?:\/|$))[^/\\\u0000]+\/)*(?!\.{1,2}$)[^/\\\u0000]+$/;

/**
 * Git 相对路径值对象校验。
 *
 * 项目内路径必须使用正斜杠，且不能是绝对路径、盘符路径或包含
 * `.` / `..` 段。目录和文件使用同一 Git 路径表示，均不得以 `/` 结尾。
 */
export function isGitRelativePath(value: string): boolean {
  return GIT_RELATIVE_PATH_PATTERN.test(value);
}

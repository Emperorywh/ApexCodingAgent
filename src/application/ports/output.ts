/**
 * OutputPort：进度摘要与风险提示的统一输出口（SPEC §17 start 进度行、§16 风险提示）。
 *
 * 只承载单行、已脱敏的用户可见文本；实现（控制台 stdout/stderr）属于
 * interfaces/bootstrap 层，Application 用例不直接依赖 node:* 输出。
 */
export interface OutputPort {
  writeLine(line: string): void;
}

/**
 * OutputPort：进度摘要与风险提示的统一输出口（SPEC §17 start 进度行、§16 风险提示）。
 *
 * 持久行进入终端滚动历史；临时状态行只表达当前仍在变化的活动，由具有
 * 交互能力的 Interface 原位刷新。重定向、CI 等非交互实现可把临时状态
 * 降级为普通行，但 Application 不感知 TTY、ANSI 或第三方渲染库。
 *
 * 所有方法只承载已脱敏的用户可见文本；实现（控制台 stdout/stderr）属于
 * interfaces/bootstrap 层，Application 用例不直接依赖 node:* 输出。
 */
export interface OutputPort {
  /** 写入必须保留在滚动历史中的稳定事实。 */
  writeLine(line: string): void;
  /** 创建或替换当前临时状态；同一时刻最多存在一个。 */
  updateStatus(line: string): void;
  /** 清除当前临时状态，结束行必须在清除后再持久化。 */
  clearStatus(): void;
}

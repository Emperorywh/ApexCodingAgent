/**
 * RunArchivePort（SPEC §4.4）。终态 Run 的历史归档边界：把
 * `.apex-coding-agent/` 根级的终态 Run 状态自包含地移动到
 * `history/<run-id>/`，并清理根级状态文件。实现属于 adapters 层；
 * Application 用例只依赖本端口。
 */
import type { RunJson } from '../../domain/schemas/run-json.js';

export interface RunArchivePort {
  /** SPEC §4.4：把终态 Run 自包含归档到 history/<run-id>/ 并清理根级状态；幂等。 */
  archiveTerminalRun(run: RunJson): Promise<void>;
}

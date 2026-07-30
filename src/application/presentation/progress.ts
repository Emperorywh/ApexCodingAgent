/**
 * 前台进度文案的统一呈现模型。
 *
 * Application 用例只提供已经确认的业务事实，本模块负责把事实压缩成稳定、
 * 易扫读的单行文本。终端颜色和控制序列清理由 Interface 层负责，结构化
 * 调试事实仍由 LoggerPort 独立保存，避免“用户进度”和“排错日志”再次混杂。
 */
import type {
  ClaudeStreamDisplayEvent,
} from '../ports/ClaudeRuntimePort.js';
import type { SessionType } from '../../domain/schemas/active-session.js';

const DETAIL_LIMIT = 112;

const SESSION_LABELS: Readonly<Record<SessionType, string>> = {
  planning: '规划',
  execution: '任务执行',
  final_review: '最终复核',
};

const TOOL_LABELS: Readonly<Record<string, string>> = {
  Bash: '执行',
  Edit: '编辑',
  Glob: '查找文件',
  Grep: '搜索内容',
  Read: '读取',
  Task: '启动子任务',
  WebFetch: '获取网页',
  WebSearch: '搜索网络',
  Write: '写入',
};

/**
 * 用大小写不敏感的方式压缩工作区绝对路径。
 *
 * Windows 路径可能同时使用两种分隔符，Claude 的工具参数也可能混用；
 * 这里不做文件系统访问，只把已知仓库根替换成“.”，让动作行保留辨识度
 * 而不会被重复的长前缀淹没。
 */
function compactWorkspacePath(text: string, repositoryRoot: string): string {
  const normalizedText = text.replaceAll('\\', '/');
  const normalizedRoot = repositoryRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const lowerText = normalizedText.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();
  let cursor = 0;
  let out = '';
  for (;;) {
    const found = lowerText.indexOf(lowerRoot, cursor);
    if (found === -1) return `${out}${normalizedText.slice(cursor)}`;
    out += `${normalizedText.slice(cursor, found)}.`;
    cursor = found + normalizedRoot.length;
  }
}

/**
 * 折叠动态详情为一行并施加统一长度上限。
 *
 * 默认终端只展示“正在做什么”，完整命令、工具结果和 Claude 原始事件仍在
 * Session 日志中，因此截断不会造成排错事实丢失。
 */
export function compactProgressDetail(
  text: string,
  repositoryRoot: string,
  limit: number = DETAIL_LIMIT,
): string {
  const oneLine = compactWorkspacePath(text, repositoryRoot).replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}

/** 三类 Session 的稳定中文阶段名。 */
export function sessionDisplayName(type: SessionType): string {
  return SESSION_LABELS[type];
}

/** 启动横幅只出现一次，后续行通过缩进与语义符号形成视觉层级。 */
export function renderAgentBanner(version: string): string {
  return `ApexCodingAgent ${version}`;
}

/** Claude 能力探测开始行。 */
export function renderClaudeProbeStarted(): string {
  return '◇ 正在检查 Claude Code 运行环境…';
}

/** Claude 能力探测成功行。 */
export function renderClaudeProbeCompleted(version: string, capabilityCount: number): string {
  return `✓ Claude Code ${version} · ${capabilityCount} 项能力就绪`;
}

/** Session 开始行：阶段、Task、Revision 与短 Session ID 在一行内完整呈现。 */
export function renderSessionStarted(input: {
  readonly sessionId: string;
  readonly type: SessionType;
  readonly taskId: string | null;
  readonly planRevision: number;
}): string {
  const task = input.taskId === null ? '' : ` ${input.taskId}`;
  return (
    `◆ ${sessionDisplayName(input.type)}${task}` +
    ` · 计划版本 ${input.planRevision} · 会话 ${input.sessionId.slice(0, 8)}`
  );
}

/** 模型事实单独缩进展示，避免在后续每条事件上重复 Session 前缀。 */
export function renderSessionModel(model: string, provider: string | null): string {
  return `  模型 ${model}${provider === null ? '' : ` · Provider ${provider}`}`;
}

/**
 * 默认终端只展示可行动的工具事件和工具错误。
 *
 * thinking、system、普通文本和成功工具结果会产生大量低信噪比内容；它们
 * 完整保存在 Session 日志中，不再逐条冲刷用户终端。
 */
export function renderSessionActivity(
  event: ClaudeStreamDisplayEvent,
  repositoryRoot: string,
): string | null {
  if (event.kind !== 'tool' && event.kind !== 'tool_error') return null;
  const label =
    event.kind === 'tool_error'
      ? '工具失败'
      : (TOOL_LABELS[event.label] ?? event.label);
  const detail =
    event.detail === null ? '' : `  ${compactProgressDetail(event.detail, repositoryRoot)}`;
  return `  ${event.kind === 'tool_error' ? '!' : '→'} ${label}${detail}`;
}

/**
 * 长 Session 的静默心跳。
 *
 * 有效事件数排除高频内部遥测，因此只能表达已完成解析的工作事件，不再把
 * 原始协议字节增长误导成任务进度；存活事实仍由固定间隔心跳独立表达。
 */
export function renderSessionHeartbeat(elapsed: string, relevantEventCount: number): string {
  return `  … 已运行 ${elapsed} · 已处理 ${relevantEventCount} 个有效事件 · Claude 仍在工作`;
}

/** Session 成功结束行。 */
export function renderSessionFinished(
  type: SessionType,
  elapsed: string,
  model: string | null,
): string {
  return (
    `  ✓ ${sessionDisplayName(type)}完成 · 用时 ${elapsed}` +
    `${model === null ? '' : ` · 模型 ${model}`}`
  );
}

/** Session 失败结束行；稳定错误码始终保留。 */
export function renderSessionFailed(
  type: SessionType,
  elapsed: string,
  errorCode: string,
): string {
  /*
   * 中断仍沿用失败持久化协议，但前台文案单独表达用户动作，避免把可恢复
   * 断点误读成 Claude 或任务实现失败。
   */
  if (errorCode === 'RUN_INTERRUPTED') {
    return `  ◇ ${sessionDisplayName(type)}已中断 · 用时 ${elapsed} · ${errorCode}`;
  }
  return `  ✗ ${sessionDisplayName(type)}失败 · 用时 ${elapsed} · ${errorCode}`;
}

/** Planning 成功提交后的阶段摘要，同时保留本轮任务规模。 */
export function renderPlanCommitted(planRevision: number, taskCount: number): string {
  return `✓ 规划完成 · 计划版本 ${planRevision} · ${taskCount} 个任务`;
}

/** SPEC 变化触发的新一轮规划。 */
export function renderSpecReplanning(): string {
  return '↻ SPEC 已变化 · 正在重新规划';
}

/** 单个 Task 完成后的稳定 Checkpoint 摘要。 */
export function renderTaskCompleted(taskId: string, checkpoint: string): string {
  return `✓ ${taskId} 完成 · Checkpoint ${checkpoint.slice(0, 12)}`;
}

/** Execution 或 Final Review 请求重新规划。 */
export function renderReplanRequested(trigger: string): string {
  return `↻ 需要重新规划 · ${trigger}`;
}

/** 所有 Task 完成后进入 Final Review。 */
export function renderFinalReviewStarted(): string {
  return '◇ 所有任务已完成 · 开始最终复核';
}

/** Run 的唯一成功终态摘要。 */
export function renderRunCompleted(
  runId: string,
  reportPath: string,
): string {
  return `✓ Run ${runId} 完成 · 报告 ${reportPath}`;
}

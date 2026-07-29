/**
 * Resume 命令的状态发现、资格判定和纯状态重开策略。
 *
 * 该模块不创建 Git/Claude 端口、不启动进程、不写文件：状态目录发现只
 * 依赖 FileSystemPort，资格与重开均为显式数据转换。这样 resume 可以先
 * 读取原 Run 的运行时快照，再决定最终 CLI 路径和外部端口。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import { assertRunTransition, isTerminalRunStatus } from '../../domain/run-state.js';
import type { ResumePoint, RunJson } from '../../domain/schemas/run-json.js';
import { assertTaskTransition } from '../../domain/task-state.js';
import type { FileSystemPort } from '../ports/file-system.js';
import type { StateStorePort } from '../ports/state-store.js';
import type { OwnerLiveness } from './run-heartbeat.js';

const STATE_DIR_NAME = '.apex-coding-agent';

export interface DiscoveredResumeState {
  readonly root: string;
  readonly stateDir: string;
  readonly stateStore: StateStorePort;
  readonly run: RunJson;
}

export interface ResumeClassification {
  readonly point: ResumePoint;
  readonly requiresOrphanReconciliation: boolean;
  /** 分类时依据的属主存活性（终态恢复为 null：无需判定）。 */
  readonly liveness: OwnerLiveness | null;
}

/** Windows 绝对路径统一为 `/`，仅用于应用层路径比较与向上遍历。 */
function normalizeAbsolutePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return /^[A-Za-z]:\/$/.test(normalized)
    ? normalized
    : normalized.replace(/\/+$/, '');
}

/** 返回父目录；到达盘符根目录后返回 null。 */
function parentPath(path: string): string | null {
  if (/^[A-Za-z]:\/$/.test(path)) return null;
  const index = path.lastIndexOf('/');
  if (index === 2 && /^[A-Za-z]:/.test(path)) return `${path.slice(0, 2)}/`;
  if (index <= 0) return null;
  return path.slice(0, index);
}

function childPath(parent: string, child: string): string {
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

function sameWindowsPath(left: string, right: string): boolean {
  return normalizeAbsolutePath(left).toLowerCase() ===
    normalizeAbsolutePath(right).toLowerCase();
}

/**
 * 从命令目录向上寻找最近的有效 run.json。
 *
 * 该过程不依赖 PATH 中的 Git，因此即使原 Run 只能通过持久化的自定义
 * Git 路径运行，也可以先恢复配置快照。找到状态后再由 Git 端口确认真实
 * repositoryRoot，状态目录本身不能替代 Git 的仓库边界校验。
 */
export async function discoverResumeState(
  fileSystem: FileSystemPort,
  makeStateStore: (stateDir: string) => StateStorePort,
  cwd: string,
): Promise<DiscoveredResumeState> {
  let cursor = normalizeAbsolutePath(await fileSystem.realpath(cwd));
  for (;;) {
    const stateDir = childPath(cursor, STATE_DIR_NAME);
    const runPath = childPath(stateDir, 'run.json');
    const stat = await fileSystem.stat(runPath);
    if (stat?.isFile === true) {
      const stateStore = makeStateStore(stateDir);
      let run: RunJson | null;
      try {
        run = await stateStore.readRun();
      } catch (error) {
        if (isApexError(error) && error.errorCode === 'STATE_VALIDATION_FAILED') {
          throw new ApexError({
            code: 'COMMAND_STATE_INVALID',
            stage: 'resume',
            message: `run.json is not a strictly valid state file: ${error.message}`,
            cause: error,
          });
        }
        throw error;
      }
      if (run === null) {
        throw new ApexError({
          code: 'RUN_NOT_FOUND',
          stage: 'resume',
          message: 'run.json disappeared while preparing resume',
        });
      }
      if (!sameWindowsPath(run.repository.root, cursor)) {
        throw new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'resume',
          message:
            `run.json repository root ${run.repository.root} does not match ` +
            `its state directory parent ${cursor}`,
        });
      }
      return { root: cursor, stateDir, stateStore, run };
    }

    const parent = parentPath(cursor);
    if (parent === null) {
      throw new ApexError({
        code: 'RUN_NOT_FOUND',
        stage: 'resume',
        message: 'no run.json exists in the current directory or any parent; nothing to resume',
      });
    }
    cursor = parent;
  }
}

/**
 * 只根据已校验 Run、显式 --force 与属主存活性判定恢复形态。
 *
 * 非终态 Run 的接管门槛（§17 resume + §2.4 崩溃判定）：
 * - 存活信号判定崩溃离场：系统有确切依据，免 --force 自动接管；
 * - 信号新鲜或不可读：旧进程可能仍在，必须显式 --force；
 * - 无信号（旧版本 Run 或信号未写入）：保持原有人工确认 + --force 语义。
 */
export function classifyResumeRun(
  run: RunJson,
  force: boolean,
  liveness: OwnerLiveness,
): ResumeClassification {
  if (isTerminalRunStatus(run.status)) {
    if (run.status !== 'failed' || run.resumePoint === null) {
      throw new ApexError({
        code: 'RUN_NOT_RESUMABLE',
        stage: 'resume',
        message:
          run.status === 'failed'
            ? `run ${run.runId} failed with ${run.lastError?.errorCode ?? 'unknown'}; ` +
              'only RUN_INTERRUPTED failures can be resumed — use abandon --force and start a new run'
            : `run ${run.runId} is already terminal (${run.status}); nothing to resume`,
      });
    }
    return { point: run.resumePoint, requiresOrphanReconciliation: false, liveness: null };
  }

  if (force || liveness.kind === 'presumed_dead') {
    return {
      point: {
        fromStatus: run.status,
        taskId: run.currentTaskId,
        sessionId: run.activeSession?.sessionId ?? null,
      },
      requiresOrphanReconciliation: true,
      liveness,
    };
  }

  if (liveness.kind === 'active') {
    throw new ApexError({
      code: 'RESUME_REQUIRES_FORCE',
      stage: 'resume',
      message:
        `run ${run.runId} is ${run.status} and its owner process is still alive ` +
        `(heartbeat ${Math.round(liveness.ageMs / 1000)}s ago); confirm it has exited, ` +
        'then resume requires the explicit --force flag',
    });
  }
  if (liveness.kind === 'unreadable') {
    throw new ApexError({
      code: 'RESUME_REQUIRES_FORCE',
      stage: 'resume',
      message:
        `run ${run.runId} is ${run.status} and its heartbeat file is unreadable; ` +
        'a live process may still own it — resume requires the explicit --force flag',
    });
  }
  throw new ApexError({
    code: 'RESUME_REQUIRES_FORCE',
    stage: 'resume',
    message:
      `run ${run.runId} is ${run.status} (possibly still owned by a crashed process); ` +
      'resume requires the explicit --force flag',
  });
}

/**
 * 组装唯一的 run.json 重开提交点。
 *
 * `validatedHead` 来自完整 Git 恢复预检；如果被中断 Session 已创建安全
 * 后继提交，这里同步 expectedHead，保证下一 Session 的普通启动不变量
 * 与真实仓库一致。恢复点只在该提交点成功写入时才被消费。
 */
export function reopenRun(
  original: RunJson,
  reconciled: RunJson,
  point: ResumePoint,
  validatedHead: string,
  at: string,
): RunJson {
  let reopened = reconciled;
  if (point.taskId !== null) {
    const task = reopened.tasks[point.taskId];
    if (task === undefined) {
      throw new ApexError({
        code: 'COMMAND_STATE_INVALID',
        stage: 'resume',
        message: `resumePoint task ${point.taskId} has no runtime state`,
      });
    }
    assertTaskTransition(task.status, 'pending', 'run_resumed');
    reopened = {
      ...reopened,
      tasks: {
        ...reopened.tasks,
        [point.taskId]: { ...task, status: 'pending', failure: null },
      },
    };
  }
  if (isTerminalRunStatus(original.status)) {
    assertRunTransition(original.status, point.fromStatus);
  }
  return {
    ...reopened,
    status: point.fromStatus,
    activeSession: null,
    currentTaskId: null,
    lastError: null,
    terminalAt: null,
    resumePoint: null,
    repository: { ...reopened.repository, expectedHead: validatedHead },
    updatedAt: at,
    stateRevision: reopened.stateRevision + 1,
  };
}

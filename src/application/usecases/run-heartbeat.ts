/**
 * 前台属主存活信号（SPEC §2.4 崩溃判定的系统依据，§8.1 第 12 项的活性判据）。
 *
 * 设计边界（与 §2.4 一致）：系统不保存 PID、不管理进程树、不构成后台
 * 停止协议、不承诺崩溃恢复。存活信号只是前台 start/resume 进程周期性
 * 写入状态目录的一个时间戳事实：
 *
 * - 写入端：Run 创建（start）或重开（resume）后立即写第一拍，随后按
 *   {@link HEARTBEAT_INTERVAL_MS} 周期覆盖 `heartbeat.json`，进程退出时
 *   信号自然停止；文件保留为"最后一次已知存活时间"，永不随进程结束删除；
 * - 读取端：start / resume / abandon 发现非终态 Run 时读取信号，把
 *   "旧进程是否还在"从纯人工排查变成有依据的判定——信号超时判定为崩溃
 *   离场（resume 免 --force 接管），信号新鲜判定为存活（继续拦截），
 *   无信号或不可读保持 §17 原有的人工确认 + --force 语义。
 *
 * 保守方向始终偏向"存活"：时钟回拨（age 为负）、文件不可读、runId 不
 * 匹配（属于其他 Run 的残留信号）都不会被误判为崩溃。
 */
import { formatRfc3339Utc } from '../../domain/time.js';
import type { ClockPort } from '../ports/clock.js';
import type { LoggerPort } from '../ports/logger.js';
import type { StateStorePort } from '../ports/state-store.js';

/** 存活信号写入间隔。远小于超时阈值，且写放大可忽略（单文件覆盖）。 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * 判定崩溃离场的信号超时阈值（6 倍写入间隔）。必须足够宽松：事件循环
 * 短暂卡顿、磁盘抖动都不应把活跃进程误判为崩溃——误判会让 resume 在旧
 * 进程仍存活时免 --force 接管，造成双进程并发写仓库。
 */
export const HEARTBEAT_STALE_MS = 30_000;

/** 对当前 Run 属主进程存活性的判定结果。 */
export type OwnerLiveness =
  /** 信号在阈值内新鲜；属主进程视为仍然存活。 */
  | { readonly kind: 'active'; readonly at: string; readonly ageMs: number }
  /** 信号文件存在但不可解析：可能有活跃写入者，按存活方向保守处理。 */
  | { readonly kind: 'unreadable' }
  /** 信号超过阈值未更新；属主进程判定为崩溃离场。 */
  | { readonly kind: 'presumed_dead'; readonly at: string; readonly ageMs: number }
  /** 无信号或信号属于其他 Run：无法判断，保持人工确认语义。 */
  | { readonly kind: 'unknown' };

/**
 * 读取并判定当前 Run 的属主存活性。
 *
 * 只有与 `runId` 精确匹配的信号才有判定效力：归档清理前的旧 Run 残留
 * 信号、其他仓库的信号一律视为无信号。
 */
export async function readOwnerLiveness(
  stateStore: StateStorePort,
  clock: ClockPort,
  runId: string,
  staleMs: number = HEARTBEAT_STALE_MS,
): Promise<OwnerLiveness> {
  const fact = await stateStore.readHeartbeat();
  if (fact === null) return { kind: 'unknown' };
  if (fact === 'unreadable') return { kind: 'unreadable' };
  if (fact.runId !== runId) return { kind: 'unknown' };
  const atMs = Date.parse(fact.at);
  if (Number.isNaN(atMs)) return { kind: 'unreadable' };
  const ageMs = Math.max(0, clock.now().getTime() - atMs);
  return ageMs > staleMs
    ? { kind: 'presumed_dead', at: fact.at, ageMs }
    : { kind: 'active', at: fact.at, ageMs };
}

export interface RunHeartbeat {
  /** 立即写入第一拍并启动周期写入；重复调用安全。 */
  start(): void;
  /** 停止周期写入（幂等）；已写入的文件保留，不删除。 */
  close(): void;
}

/**
 * 创建前台属主存活信号写入器。
 *
 * 信号写入是尽力而为的运行期事实：单次写失败只记调试日志，绝不让一个
 * 辅助信号拖垮正在进行的 Run（状态目录真正不可写时，run.json 的正式
 * 写协议会以 STATE_WRITE_FAILED 正常表面化）。
 */
export function createRunHeartbeat(options: {
  readonly stateStore: StateStorePort;
  readonly clock: ClockPort;
  readonly runId: string;
  readonly logger: LoggerPort;
  readonly intervalMs?: number;
  /** 注入的周期调度器（组合根：unref 的 setInterval）；返回解除函数。 */
  readonly scheduleInterval: (callback: () => void, intervalMs: number) => () => void;
}): RunHeartbeat {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let unschedule: (() => void) | null = null;
  let writeInFlight = false;

  const beat = (): void => {
    // 慢磁盘上一拍未写完时跳过本拍，避免写请求无限积压。
    if (writeInFlight) return;
    writeInFlight = true;
    void options.stateStore
      .writeHeartbeat({
        runId: options.runId,
        at: formatRfc3339Utc(options.clock.now()),
      })
      .catch((error: unknown) => {
        options.logger.log('debug', 'run.heartbeat_write_failed', {
          runId: options.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        writeInFlight = false;
      });
  };

  return {
    start() {
      if (unschedule !== null) return;
      // 立即第一拍：消除 Run 创建/重开到首个周期间的判定空窗。
      beat();
      unschedule = options.scheduleInterval(beat, intervalMs);
    },
    close() {
      if (unschedule === null) return;
      unschedule();
      unschedule = null;
    },
  };
}

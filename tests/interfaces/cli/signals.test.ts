/**
 * 中断信号两次语义的单元测试（SPEC §2.4）：第一次转发有界收尾入口且
 * 不退出；第二次立即 exit(130)；解除后不再响应。平台覆盖：Windows 只装
 * SIGINT；Unix 追加 SIGTERM/SIGHUP 且共用同一两次语义。进程级投递见
 * process.test.ts（Windows 上经 --import 钩子直接调用监听器）。
 */
import { describe, expect, it } from 'vitest';
import {
  installInterruptSignals,
  type InterruptSignal,
  type SignalTarget,
} from '../../../src/bootstrap/signals.js';

function makeTarget(): SignalTarget & {
  emit(signal?: InterruptSignal): void;
  listenerCount(signal?: InterruptSignal): number;
  totalListenerCount(): number;
} {
  const listeners = new Map<InterruptSignal, Set<() => void>>();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(signal: InterruptSignal = 'SIGINT') {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener();
    },
    listenerCount(signal: InterruptSignal = 'SIGINT') {
      return listeners.get(signal)?.size ?? 0;
    },
    totalListenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

describe('installInterruptSignals (§2.4)', () => {
  it('first signal runs the bounded-settlement entry without exiting', () => {
    const target = makeTarget();
    let first = 0;
    const exits: number[] = [];
    installInterruptSignals({
      onFirstInterrupt: () => {
        first += 1;
      },
      exit: (code) => exits.push(code),
      target,
      platform: 'win32',
    });
    target.emit();
    expect(first).toBe(1);
    expect(exits).toEqual([]);
  });

  it('second signal exits immediately with 130', () => {
    const target = makeTarget();
    let first = 0;
    const exits: number[] = [];
    installInterruptSignals({
      onFirstInterrupt: () => {
        first += 1;
      },
      exit: (code) => exits.push(code),
      target,
      platform: 'win32',
    });
    target.emit();
    target.emit();
    expect(first).toBe(1); // 第一次回调不重复执行
    expect(exits).toEqual([130]);
    target.emit();
    expect(exits).toEqual([130, 130]); // 后续信号保持立即退出语义
  });

  it('custom second-signal handler overrides the default exit', () => {
    const target = makeTarget();
    let second = 0;
    const exits: number[] = [];
    installInterruptSignals({
      onFirstInterrupt: () => {},
      onSecondInterrupt: () => {
        second += 1;
      },
      exit: (code) => exits.push(code),
      target,
      platform: 'win32',
    });
    target.emit();
    target.emit();
    expect(second).toBe(1);
    expect(exits).toEqual([]);
  });

  it('dispose removes the listener', () => {
    const target = makeTarget();
    let first = 0;
    const dispose = installInterruptSignals({
      onFirstInterrupt: () => {
        first += 1;
      },
      target,
      platform: 'win32',
    });
    expect(target.listenerCount()).toBe(1);
    dispose();
    expect(target.listenerCount()).toBe(0);
    target.emit();
    expect(first).toBe(0);
  });

  it('installs only SIGINT on Windows', () => {
    const target = makeTarget();
    installInterruptSignals({
      onFirstInterrupt: () => {},
      exit: () => {},
      target,
      platform: 'win32',
    });
    expect(target.listenerCount('SIGINT')).toBe(1);
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(target.listenerCount('SIGHUP')).toBe(0);
    expect(target.totalListenerCount()).toBe(1);
  });

  it('installs SIGTERM and SIGHUP alongside SIGINT on Unix platforms', () => {
    for (const platform of ['linux', 'darwin']) {
      const target = makeTarget();
      installInterruptSignals({
        onFirstInterrupt: () => {},
        exit: () => {},
        target,
        platform,
      });
      expect(target.listenerCount('SIGINT')).toBe(1);
      expect(target.listenerCount('SIGTERM')).toBe(1);
      expect(target.listenerCount('SIGHUP')).toBe(1);
      expect(target.totalListenerCount()).toBe(3);
    }
  });

  it('applies the same two-press semantics to Unix termination signals', () => {
    const target = makeTarget();
    let first = 0;
    const exits: number[] = [];
    installInterruptSignals({
      onFirstInterrupt: () => {
        first += 1;
      },
      exit: (code) => exits.push(code),
      target,
      platform: 'linux',
    });
    target.emit('SIGTERM');
    expect(first).toBe(1);
    expect(exits).toEqual([]);
    target.emit('SIGHUP');
    expect(first).toBe(1);
    expect(exits).toEqual([130]);
  });

  it('dispose removes every installed Unix signal listener', () => {
    const target = makeTarget();
    const dispose = installInterruptSignals({
      onFirstInterrupt: () => {},
      exit: () => {},
      target,
      platform: 'darwin',
    });
    expect(target.totalListenerCount()).toBe(3);
    dispose();
    expect(target.totalListenerCount()).toBe(0);
    target.emit('SIGTERM');
    target.emit('SIGHUP');
  });
});

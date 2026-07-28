/**
 * 中断信号两次语义的单元测试（SPEC §2.4）：第一次转发有界收尾入口且
 * 不退出；第二次立即 exit(130)；解除后不再响应。进程级投递见
 * process.test.ts（Windows 上经 --import 钩子直接调用监听器）。
 */
import { describe, expect, it } from 'vitest';
import {
  installInterruptSignals,
  type SignalTarget,
} from '../../../src/bootstrap/signals.js';

function makeTarget(): SignalTarget & { emit(): void; listenerCount(): number } {
  const listeners = new Set<() => void>();
  return {
    on(event, listener) {
      if (event === 'SIGINT') listeners.add(listener);
    },
    removeListener(event, listener) {
      if (event === 'SIGINT') listeners.delete(listener);
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
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
    });
    expect(target.listenerCount()).toBe(1);
    dispose();
    expect(target.listenerCount()).toBe(0);
    target.emit();
    expect(first).toBe(0);
  });
});

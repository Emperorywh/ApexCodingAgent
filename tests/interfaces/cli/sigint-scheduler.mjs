/**
 * 进程级信号测试钩子（仅测试使用，经 `node --import` 注入 CLI 子进程）。
 *
 * 背景：Windows 上不存在可由纯 Node 编程投递的进程间中断信号——
 * `process.kill(pid, 'SIGINT')` 是对目标进程的无条件终止，不会触发
 * 目标内注册的 SIGINT 监听（真实 Ctrl+C 由控制台子系统投递，自动化
 * 测试无法在无 FFI 的条件下生成）。
 *
 * 本钩子在被测进程内拦截 SIGINT 监听的注册，待 run.json 出现非空
 * activeSession（前台 Session 已接力）后**直接调用该监听器**——这与
 * Node 在真实 Ctrl+C 时执行的是同一个函数，之后的 §2.4 有界收尾、
 * 退出码映射全部走生产代码路径。
 *
 * 环境变量：
 * - APEX_TEST_SIGINT_STATEDIR：状态目录；轮询其 run.json。
 * - APEX_TEST_SIGINT_SECOND_MS：>0 时，第一次触发后该毫秒数再触发第二次。
 */
import { readFileSync } from 'node:fs';

const stateDir = process.env.APEX_TEST_SIGINT_STATEDIR;
const secondMs = Number(process.env.APEX_TEST_SIGINT_SECOND_MS ?? '0') || 0;

if (stateDir !== undefined && stateDir !== '') {
  const listeners = [];
  const originalOn = process.on.bind(process);
  process.on = (event, listener) => {
    if (event === 'SIGINT' && typeof listener === 'function') {
      listeners.push(listener);
      return process;
    }
    return originalOn(event, listener);
  };

  const fire = () => {
    for (const listener of [...listeners]) listener();
  };

  const poll = setInterval(() => {
    let ready = false;
    try {
      const run = JSON.parse(readFileSync(`${stateDir}/run.json`, 'utf8'));
      ready = run.activeSession !== null && run.activeSession !== undefined;
    } catch {
      ready = false; // run.json 尚未创建或仍在替换中
    }
    if (!ready) return;
    clearInterval(poll);
    fire();
    if (secondMs > 0) setTimeout(fire, secondMs);
  }, 50);

  // 保底：30 秒未就绪则停止轮询（测试将超时并杀掉子进程而失败）。
  setTimeout(() => clearInterval(poll), 30_000).unref();
}

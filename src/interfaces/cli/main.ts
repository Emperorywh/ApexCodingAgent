#!/usr/bin/env node
/**
 * ApexCodingAgent CLI 入口（SPEC §17）。只做进程级接线：收集 argv、
 * 环境事实与控制台 Sink，委托 Composition Root 组装运行时后分发命令。
 * 业务规则全部在 Application/Domain；信号语义在 bootstrap/signals。
 */
import { createCliRuntime } from '../../bootstrap/composition-root.js';
import { collectEnvironmentFacts } from '../../bootstrap/environment.js';
import { createConsolePresenter } from './console-output.js';
import { runCli } from './run.js';

/*
 * 颜色只属于真实 TTY 呈现，重定向和 CI 始终输出纯文本。
 * 遵循 NO_COLOR 约定，用户无需额外 Apex 专用配置即可关闭颜色。
 */
const colorEnabled = process.env['NO_COLOR'] === undefined;
/*
 * stdout 与 stderr 必须共享同一个呈现器：活动状态位于 stdout 底部，任何
 * stderr 诊断写入前都要暂时让出该区域，否则两个流可能交错破坏终端布局。
 * 呈现器只处理终端能力，业务输出仍经 Composition Root 注入 OutputPort。
 */
const consolePresenter = createConsolePresenter({
  stdout: process.stdout,
  stderr: process.stderr,
  colorEnabled,
});

const runtime = createCliRuntime({
  cwd: process.cwd(),
  environment: collectEnvironmentFacts(),
  stdout: (text) => consolePresenter.writeStdout(text),
  stderr: (text) => consolePresenter.writeStderr(text),
  updateStatus: (text) => consolePresenter.updateStatus(text),
  clearStatus: () => consolePresenter.clearStatus(),
});

const exitCode = await runCli(process.argv.slice(2), runtime);
// 用 exitCode 而非 process.exit：让 stdout/stderr 先行冲刷（§17 诊断完整性）。
process.exitCode = exitCode;

#!/usr/bin/env node
/**
 * ApexCodingAgent CLI 入口（SPEC §17）。只做进程级接线：收集 argv、
 * 环境事实与控制台 Sink，委托 Composition Root 组装运行时后分发命令。
 * 业务规则全部在 Application/Domain；信号语义在 bootstrap/signals。
 */
import { createCliRuntime } from '../../bootstrap/composition-root.js';
import { collectEnvironmentFacts } from '../../bootstrap/environment.js';
import { runCli } from './run.js';

const runtime = createCliRuntime({
  cwd: process.cwd(),
  environment: collectEnvironmentFacts(),
  stdout: (text) => {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  },
  stderr: (text) => {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  },
});

const exitCode = await runCli(process.argv.slice(2), runtime);
// 用 exitCode 而非 process.exit：让 stdout/stderr 先行冲刷（§17 诊断完整性）。
process.exitCode = exitCode;

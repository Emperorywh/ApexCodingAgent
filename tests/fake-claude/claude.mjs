#!/usr/bin/env node
/**
 * 可编程 Fake Claude CLI。被测适配器通过当前 Node 运行时启动本脚本，
 * 因此参数数组、继承环境、stream-json stdout、stderr 和退出码都经过
 * 与真实 CLI 相同的进程边界。
 *
 * APEX_FAKE_CLAUDE_SCENARIO 指向控制行为的场景 JSON：
 *
 * {
 *   "version": "1.2.3 (fake-claude)",   // --version 的 stdout
 *   "versionExitCode": 0,
 *   "help": "Usage: claude ...",        // --help 的 stdout
 *   "helpExitCode": 0,
 *   "stdoutLines": [ {…}, "raw line" ], // 对象编码为 JSON，字符串原样输出；
 *                                       // {sessionId} 替换为收到的 Session ID
 *   "printEnv": ["NAME"],               // 以额外 stdout 事件回显环境变量
 *   "stderrText": "…",
 *   "exitCode": 0,
 *   "sleepMs": 0,                        // 中断场景使用的存活时长
 *   "recordEnv": ["NAME"]                // 需要记录的环境变量名称
 * }
 *
 * 每次调用向 APEX_FAKE_CLAUDE_RECORD 追加一行 argv、cwd 和筛选后的 env，
 * 供集成测试断言精确的进程调用事实。
 */
import { appendFileSync, readFileSync } from 'node:fs';

const scenarioPath = process.env.APEX_FAKE_CLAUDE_SCENARIO;
if (scenarioPath === undefined || scenarioPath === '') {
  process.stderr.write('fake-claude: APEX_FAKE_CLAUDE_SCENARIO is not set\n');
  process.exit(64);
}
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

const argv = process.argv.slice(2);

const recordPath = process.env.APEX_FAKE_CLAUDE_RECORD;
if (recordPath !== undefined && recordPath !== '') {
  const env = {};
  for (const name of scenario.recordEnv ?? []) {
    env[name] = process.env[name] ?? null;
  }
  appendFileSync(recordPath, JSON.stringify({ argv, cwd: process.cwd(), env }) + '\n', 'utf8');
}

function sessionIdArgument() {
  const index = argv.indexOf('--session-id');
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function emitSessionStdout() {
  const sessionId = sessionIdArgument();
  for (const line of scenario.stdoutLines ?? []) {
    const text = (typeof line === 'string' ? line : JSON.stringify(line))
      .split('{sessionId}')
      .join(sessionId ?? '');
    process.stdout.write(text + '\n');
  }
  for (const name of scenario.printEnv ?? []) {
    process.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'env-echo',
        name,
        value: process.env[name] ?? null,
      }) + '\n',
    );
  }
}

async function main() {
  if (argv.includes('--version')) {
    process.stdout.write((scenario.version ?? '0.0.0 (fake-claude)') + '\n');
    process.exitCode = scenario.versionExitCode ?? 0;
    return;
  }
  if (argv.includes('--help')) {
    process.stdout.write(scenario.help ?? 'fake-claude help\n');
    process.exitCode = scenario.helpExitCode ?? 0;
    return;
  }
  emitSessionStdout();
  if (scenario.stderrText !== undefined) {
    process.stderr.write(scenario.stderrText + '\n');
  }
  if (typeof scenario.sleepMs === 'number' && scenario.sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, scenario.sleepMs));
  }
  process.exitCode = scenario.exitCode ?? 0;
}

await main();

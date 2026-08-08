#!/usr/bin/env node
/**
 * 可编程 Fake Claude CLI。被测适配器通过当前 Node 运行时启动本脚本，
 * 因此参数数组、继承环境、stream-json stdout、stderr 和退出码都经过
 * 与真实 CLI 相同的进程边界。
 *
 * APEX_FAKE_CLAUDE_SCENARIO 指向控制行为的场景 JSON。两种形态：
 *
 * 1) 单场景（G4 契约，行为不变）：
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
 * 2) 序列场景（G5 端到端）：顶层放 version/help 字段，Session 调用按调用
 *    顺序消费 "sequence" 数组（--version/--help 不消耗序号）：
 * {
 *   "version": "…", "help": "…",
 *   "sequence": [ <场景>, <场景>, … ]
 * }
 * 序号保存在 <scenarioPath>.counter；序列耗尽后以退出码 65 失败。
 *
 * 场景元素额外支持（在输出行之前执行，模拟 Claude 对仓库的真实操作）：
 *   "writeFiles": [{ "path": "src/a.ts", "content": "…", "append": false }],
 *   "commands": [{ "argv": ["git", "add", "."] }]   // 以 cwd 同步执行
 *
 * 每次调用向 APEX_FAKE_CLAUDE_RECORD 追加一行 argv、stdin、cwd 和筛选
 * 后的 env，供集成测试断言精确的进程调用事实。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const scenarioPath = process.env.APEX_FAKE_CLAUDE_SCENARIO;
if (scenarioPath === undefined || scenarioPath === '') {
  process.stderr.write('fake-claude: APEX_FAKE_CLAUDE_SCENARIO is not set\n');
  process.exit(64);
}
const scenarioFile = JSON.parse(readFileSync(scenarioPath, 'utf8'));

const argv = process.argv.slice(2);
const isProbe = argv.includes('--version') || argv.includes('--help');
/*
 * 正式 Session 使用管道传递 prompt；探测调用关闭 stdin，不能在这里等待。
 *
 * 一次性读到 EOF 与真实 print 模式的输入生命周期一致，也让集成测试能够
 * 证明长提示词没有退回 Windows 命令行参数。
 */
const stdin = isProbe ? '' : readFileSync(0, 'utf8');

const recordPath = process.env.APEX_FAKE_CLAUDE_RECORD;

function recordInvocation(scenario) {
  if (recordPath === undefined || recordPath === '') return;
  const env = {};
  for (const name of scenario.recordEnv ?? []) {
    env[name] = process.env[name] ?? null;
  }
  appendFileSync(
    recordPath,
    JSON.stringify({ argv, stdin, cwd: process.cwd(), env }) + '\n',
    'utf8',
  );
}

/**
 * 判断当前调用是否请求 TaskReviewResult Schema。
 *
 * 该测试设施分支只为既有 E2E 场景自动补齐新增的独立复核调用；生产代码
 * 仍然真实启动一个全新 Session，且显式复核测试可以关闭自动批准。
 */
function requestedSchema() {
  const schemaIndex = argv.indexOf('--json-schema');
  if (schemaIndex < 0 || schemaIndex + 1 >= argv.length) return null;
  try {
    return JSON.parse(argv[schemaIndex + 1]);
  } catch {
    return null;
  }
}

function isPlanReviewInvocation() {
  return requestedSchema()?.properties?.taskAssessments !== undefined;
}

function isTaskReviewInvocation() {
  const schema = requestedSchema();
  const decisions = schema?.properties?.decision?.enum;
  return (
    schema?.properties?.taskAssessments === undefined &&
    Array.isArray(decisions) &&
    decisions.includes('approved')
  );
}

/**
 * 从候选引用指向的不可变 Planning Session Record 生成完整批准结果。
 * 自动场景仍会真实经过独立进程、Schema 校验和只读 Git 不变量。
 *
 * 候选引用与其指向的 Planning Session Record 在 Reviewer 会话启动前必须
 * 已经落盘；读取失败说明编排时序或持久化已损坏，直接抛错让本次调用以
 * 非零退出失败，而不是猜测任务集合掩盖真实故障。
 */
function automaticPlanReviewScenario() {
  const run = JSON.parse(
    readFileSync(`${process.cwd()}/.apex-coding-agent/run.json`, 'utf8'),
  );
  const record = JSON.parse(
    readFileSync(
      `${process.cwd()}/.apex-coding-agent/sessions/${run.planCandidate.plannerSessionId}.json`,
      'utf8',
    ),
  );
  const taskIds = record.structuredResult.tasks.map((task) => task.id);
  return {
    stdoutLines: [
      { type: 'system', subtype: 'init', session_id: '{sessionId}', model: 'fake-plan-review-model' },
      {
        type: 'result',
        subtype: 'success',
        session_id: '{sessionId}',
        structured_output: {
          decision: 'approved',
          summary: '独立计划复核通过',
          taskAssessments: taskIds.map((taskId) => ({
            taskId,
            decision: 'approved',
            issues: [],
          })),
          issues: [],
        },
      },
    ],
  };
}

/** 从当前持久化计划生成与验收标准数量一致的独立批准结果。 */
function automaticTaskReviewScenario() {
  let criterionCount = 1;
  try {
    const run = JSON.parse(
      readFileSync(`${process.cwd()}/.apex-coding-agent/run.json`, 'utf8'),
    );
    const tasks = JSON.parse(
      readFileSync(`${process.cwd()}/.apex-coding-agent/tasks.json`, 'utf8'),
    );
    const task = tasks.tasks.find((item) => item.id === run.currentTaskId);
    criterionCount = task?.acceptanceCriteria?.length ?? 1;
  } catch {
    criterionCount = 1;
  }
  return {
    stdoutLines: [
      { type: 'system', subtype: 'init', session_id: '{sessionId}', model: 'fake-review-model' },
      {
        type: 'result',
        subtype: 'success',
        session_id: '{sessionId}',
        structured_output: {
          decision: 'approved',
          summary: '独立复核通过',
          tests: [{ command: 'npm test', result: 'passed' }],
          acceptanceEvidence: Array.from({ length: criterionCount }, (_, index) => ({
            criterionIndex: index,
            status: 'satisfied',
            evidence: `独立复核证据 ${index}`,
          })),
          issues: [],
          replanReason: null,
        },
      },
    ],
  };
}

/** 序列场景：按 counter 文件取出本次 Session 的场景元素。 */
function pickScenario() {
  if (!Array.isArray(scenarioFile.sequence)) return scenarioFile;
  if (scenarioFile.autoApprovePlanReviews === true && isPlanReviewInvocation()) {
    return automaticPlanReviewScenario();
  }
  if (scenarioFile.autoApproveTaskReviews === true && isTaskReviewInvocation()) {
    return automaticTaskReviewScenario();
  }
  const counterPath = `${scenarioPath}.counter`;
  const index = existsSync(counterPath)
    ? Number.parseInt(readFileSync(counterPath, 'utf8').trim(), 10) || 0
    : 0;
  writeFileSync(counterPath, String(index + 1), 'utf8');
  if (index >= scenarioFile.sequence.length) {
    process.stderr.write(
      `fake-claude: scenario sequence exhausted (call #${index + 1} of ${scenarioFile.sequence.length})\n`,
    );
    process.exit(65);
  }
  return scenarioFile.sequence[index];
}

const scenario = isProbe ? scenarioFile : pickScenario();
recordInvocation(scenario);

function sessionIdArgument() {
  const index = argv.indexOf('--session-id');
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

/** 模拟 Claude 对仓库的操作：写文件与同步命令（均以会话 cwd 为基准）。 */
function applyRepoActions() {
  for (const file of scenario.writeFiles ?? []) {
    const target = `${process.cwd()}/${file.path}`;
    mkdirSync(dirname(target), { recursive: true });
    if (file.append === true) appendFileSync(target, file.content, 'utf8');
    else writeFileSync(target, file.content, 'utf8');
  }
  for (const command of scenario.commands ?? []) {
    const [commandName, ...commandArgs] = command.argv;
    try {
      execFileSync(commandName, commandArgs, { cwd: process.cwd(), stdio: 'pipe' });
    } catch (error) {
      process.stderr.write(`fake-claude: command failed: ${command.argv.join(' ')}\n`);
      process.exit(66);
    }
  }
}

function emitSessionStdout() {
  const sessionId = sessionIdArgument();
  // 端到端场景占位符：{firstIntermediateCheckpointOid} 读取当前仓库
  // run.json 的第一个中间 Checkpoint OID（replan 接管场景使用）；
  // {intermediateCheckpointOid<N>} 读取第 N 个（多次打回保留多个候选时使用）。
  let checkpointOids = [];
  try {
    const runJson = JSON.parse(
      readFileSync(`${process.cwd()}/.apex-coding-agent/run.json`, 'utf8'),
    );
    checkpointOids = (runJson.intermediateCheckpoints ?? []).map((checkpoint) => checkpoint.oid);
  } catch {
    checkpointOids = [];
  }
  const firstCheckpointOid = checkpointOids[0] ?? '';
  for (const line of scenario.stdoutLines ?? []) {
    let text = (typeof line === 'string' ? line : JSON.stringify(line))
      .split('{sessionId}')
      .join(sessionId ?? '')
      .split('{firstIntermediateCheckpointOid}')
      .join(firstCheckpointOid);
    text = text.replace(/\{intermediateCheckpointOid(\d+)\}/g, (_, index) =>
      checkpointOids[Number(index)] ?? '',
    );
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
  applyRepoActions();
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

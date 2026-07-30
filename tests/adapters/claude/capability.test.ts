/**
 * Claude 能力探测测试。help 解析由固定 Fixture 驱动，探测编排使用脚本化
 * ProbeRunner 覆盖失败分支；真实进程路径由 Fake Claude 集成测试负责。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createCapabilityProbe,
  parseCapabilityHelp,
  REQUIRED_CAPABILITIES,
  type ProbeRunner,
} from '../../../src/adapters/claude/capability.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import { ApexError } from '../../../src/domain/errors.js';
import { expectApexErrorAsync } from '../fixtures.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/claude-help/', import.meta.url));

function helpFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

const ALL_CAPABILITY_IDS = REQUIRED_CAPABILITIES.map((check) => check.id);

describe('parseCapabilityHelp fixtures', () => {
  it('complete help confirms every required capability', () => {
    const parse = parseCapabilityHelp(helpFixture('complete.help.txt'));
    expect(parse.missing).toEqual([]);
    expect([...parse.found].sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
  });

  it('help without --json-schema reports exactly that capability missing', () => {
    const parse = parseCapabilityHelp(helpFixture('missing-json-schema.help.txt'));
    expect(parse.missing).toEqual(['json-schema']);
  });

  it('help without the auto/bypassPermissions enum values reports them missing', () => {
    const parse = parseCapabilityHelp(helpFixture('missing-permission-values.help.txt'));
    expect(parse.missing).toEqual(['permission-mode auto', 'permission-mode bypassPermissions']);
  });

  it('unparseable help means every capability is missing', () => {
    const parse = parseCapabilityHelp(helpFixture('unparseable.help.txt'));
    expect([...parse.missing].sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
  });

  it('does not accept values documented under unrelated options', () => {
    const misleadingHelp = [
      'Options:',
      '  -p, --print                     print response and exit',
      '  --output-format <format>        output format: text, json',
      '  --input-format <format>         input format: text, stream-json',
      '  --json-schema <schema>          validate structured output',
      '  --session-id <uuid>             use a specific session',
      '  --permission-mode <mode>        permission mode: plan',
      '  --update-mode <mode>            update mode: auto',
      '  --other-command                 mentions bypassPermissions elsewhere',
    ].join('\n');

    const parse = parseCapabilityHelp(misleadingHelp);
    expect(parse.missing).toEqual([
      'stream-json',
      'session-resume',
      'fork-session',
      'permission-mode auto',
      'permission-mode bypassPermissions',
    ]);
  });

  it('requires the short -p alias used by the invocation contract', () => {
    const helpWithoutShortPrint = helpFixture('complete.help.txt').replace(
      '-p, --print',
      '--print',
    );
    expect(parseCapabilityHelp(helpWithoutShortPrint).missing).toContain('print-mode');
  });
});

type ScriptedOutcome = { readonly code: number; readonly stdout: string } | 'spawn-failure';

function scriptedRunner(script: {
  readonly version?: ScriptedOutcome;
  readonly help?: ScriptedOutcome;
}): ProbeRunner {
  return async (args: readonly string[]) => {
    const which = args.includes('--version')
      ? 'version'
      : args.includes('--help')
        ? 'help'
        : undefined;
    if (which === undefined) throw new Error(`unexpected probe args: ${args.join(' ')}`);
    const outcome = script[which];
    if (outcome === undefined) throw new Error(`no scripted outcome for ${which}`);
    if (outcome === 'spawn-failure') throw new Error('spawn claude ENOENT');
    return { code: outcome.code, stdout: outcome.stdout, stderr: '' };
  };
}

const VERSION = '1.2.3 (Claude Code)';

function healthyRunner(): ProbeRunner {
  return scriptedRunner({
    version: { code: 0, stdout: `${VERSION}\n` },
    help: { code: 0, stdout: helpFixture('complete.help.txt') },
  });
}

/**
 * 能力探测返回的版本和错误详情属于外部输入，测试使用生产 Redactor 组装
 * Probe，确保适配器边界与真实组合根保持一致。
 */
const redactor = createRedactor();
function capabilityProbe(run: ProbeRunner) {
  return createCapabilityProbe(run, (text) => redactor.redactText(text));
}

describe('createCapabilityProbe', () => {
  it('confirms a healthy installation with its version and capability list', async () => {
    const report = await capabilityProbe(healthyRunner()).probeCapabilities();
    expect(report.version).toBe(VERSION);
    expect([...report.capabilities].sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
  });

  it('maps a failing --version to CLAUDE_INSTALLATION_UNHEALTHY naming the underlying reason', async () => {
    const cases: Array<{ readonly outcome: ScriptedOutcome; readonly reason: string }> = [
      { outcome: 'spawn-failure', reason: 'could not be started (spawn claude ENOENT)' },
      { outcome: { code: 1, stdout: '' }, reason: 'exited with code 1' },
      { outcome: { code: 0, stdout: '  \n' }, reason: 'produced no version output' },
    ];
    for (const { outcome, reason } of cases) {
      const probe = capabilityProbe(
        scriptedRunner({ version: outcome, help: { code: 0, stdout: helpFixture('complete.help.txt') } }),
      );
      const error = await expectApexErrorAsync(
        () => probe.probeCapabilities(),
        'CLAUDE_INSTALLATION_UNHEALTHY',
      );
      expect(error.message).toContain(reason);
    }
  });

  it('maps help output missing a capability to CLAUDE_CAPABILITY_MISSING listing it plus the version', async () => {
    const probe = capabilityProbe(
      scriptedRunner({
        version: { code: 0, stdout: VERSION },
        help: { code: 0, stdout: helpFixture('missing-json-schema.help.txt') },
      }),
    );
    let thrown: unknown;
    try {
      await probe.probeCapabilities();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApexError);
    const error = thrown as ApexError;
    expect(error.errorCode).toBe('CLAUDE_CAPABILITY_MISSING');
    expect(error.errorClass).toBe('startup_validation');
    expect(error.message).toContain('json-schema');
    expect(error.message).toContain(VERSION);
  });

  it('treats unobtainable help output as every capability missing', async () => {
    for (const help of [
      'spawn-failure',
      { code: 1, stdout: '' },
      { code: 0, stdout: '   \n' },
    ] satisfies ScriptedOutcome[]) {
      const probe = capabilityProbe(
        scriptedRunner({ version: { code: 0, stdout: VERSION }, help }),
      );
      let thrown: unknown;
      try {
        await probe.probeCapabilities();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ApexError);
      const error = thrown as ApexError;
      expect(error.errorCode).toBe('CLAUDE_CAPABILITY_MISSING');
      for (const id of ALL_CAPABILITY_IDS) {
        expect(error.message).toContain(id);
      }
    }
  });

  it('readVersion returns the trimmed version or null on any failure', async () => {
    await expect(capabilityProbe(healthyRunner()).readVersion()).resolves.toBe(VERSION);
    for (const version of [
      'spawn-failure',
      { code: 1, stdout: VERSION },
      { code: 0, stdout: '\n' },
    ] satisfies ScriptedOutcome[]) {
      const probe = capabilityProbe(scriptedRunner({ version }));
      await expect(probe.readVersion()).resolves.toBeNull();
    }
  });

  it('redacts secrets and control sequences before version facts leave the adapter', async () => {
    const secret = 'sk-proj-abcdefghijklmnop';
    const report = await capabilityProbe(
      scriptedRunner({
        version: { code: 0, stdout: `Claude\u001b[31m ${secret}\n` },
        help: { code: 0, stdout: helpFixture('complete.help.txt') },
      }),
    ).probeCapabilities();

    expect(report.version).toBe('Claude [REDACTED]');
    expect(report.version).not.toContain(secret);
    expect(report.version).not.toContain('\u001b');
  });
});

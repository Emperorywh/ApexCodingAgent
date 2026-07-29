/**
 * 启动环境事实采集：进程事实按注入来源透传；ApexCodingAgent 版本从
 * 仓库根 package.json 读取（src 与 dist 相对层级一致），作为启动横幅
 * 的数据来源。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectEnvironmentFacts } from '../../src/bootstrap/environment.js';

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version;

describe('collectEnvironmentFacts', () => {
  it('按注入来源透传平台事实', () => {
    const facts = collectEnvironmentFacts({
      platform: 'win32',
      release: '10.0.22631',
      nodeVersion: 'v22.11.0',
    });
    expect(facts.platform).toBe('win32');
    expect(facts.release).toBe('10.0.22631');
    expect(facts.nodeVersion).toBe('v22.11.0');
  });

  it('agentVersion 与安装清单 package.json 一致', () => {
    const facts = collectEnvironmentFacts();
    expect(facts.agentVersion).toBe(PACKAGE_VERSION);
    expect(facts.agentVersion).not.toBe('unknown');
  });
});

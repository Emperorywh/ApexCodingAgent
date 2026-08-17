/**
 * 环境门禁纯函数的平台矩阵（§8.1 第 1、3 项）：
 * Windows 10+/macOS/Linux 放行，其余平台拒绝；Windows 版本门禁仅作用于
 * win32，Unix 的内核版本号不参与产品版本判定。
 */
import { describe, expect, it } from 'vitest';
import { ApexError } from '../../src/domain/errors.js';
import {
  assertEnvironmentSupported,
  type EnvironmentFacts,
} from '../../src/application/usecases/run-runtime-preflight.js';

function facts(overrides: Partial<EnvironmentFacts>): EnvironmentFacts {
  return {
    platform: 'win32',
    release: '10.0.22631',
    nodeVersion: 'v22.11.0',
    agentVersion: 'test',
    ...overrides,
  };
}

describe('assertEnvironmentSupported', () => {
  it('accepts every supported platform', () => {
    expect(() => assertEnvironmentSupported(facts({ platform: 'win32' }))).not.toThrow();
    expect(() =>
      assertEnvironmentSupported(facts({ platform: 'darwin', release: '24.5.0' })),
    ).not.toThrow();
    expect(() =>
      assertEnvironmentSupported(facts({ platform: 'linux', release: '6.5.0-42-generic' })),
    ).not.toThrow();
  });

  it('rejects platforms outside the whitelist', () => {
    for (const platform of ['freebsd', 'android', 'sunos', '']) {
      let thrown: ApexError | null = null;
      try {
        assertEnvironmentSupported(facts({ platform }));
      } catch (error) {
        thrown = error as ApexError;
      }
      expect(thrown).toBeInstanceOf(ApexError);
      expect(thrown?.errorCode).toBe('ENVIRONMENT_UNSUPPORTED');
      expect(thrown?.message).toContain(platform === '' ? 'unsupported platform' : platform);
    }
  });

  it('gates the Windows release only on win32', () => {
    expect(() =>
      assertEnvironmentSupported(facts({ release: '6.3.9600' })),
    ).toThrowError(/unsupported Windows release/);
    // Unix 的 release 是内核/Darwin 版本，不做产品版本门禁。
    expect(() =>
      assertEnvironmentSupported(facts({ platform: 'linux', release: '4.15.0' })),
    ).not.toThrow();
    expect(() =>
      assertEnvironmentSupported(facts({ platform: 'darwin', release: '13.0.0' })),
    ).not.toThrow();
  });

  it('requires Node major 22 or 24 on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(() =>
        assertEnvironmentSupported(facts({ platform, nodeVersion: 'v20.18.0' })),
      ).toThrowError(/unsupported Node.js version/);
    }
  });
});

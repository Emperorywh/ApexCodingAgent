/**
 * 命令级呈现纯函数测试。
 *
 * 首屏只允许使用解析参数与环境事实，终态只允许使用用例返回值；这些断言
 * 同时锁定五个命令共享的标题、空行和缩进结构。
 */
import { describe, expect, it } from 'vitest';
import { ApexError } from '../../../src/domain/errors.js';
import {
  renderCommandError,
  renderCommandHeader,
  renderCommandSuccess,
  renderRunCommandFailure,
} from '../../../src/interfaces/cli/command-presentation.js';
import { mkRun, RUN_ID, T1 } from '../../domain/fixtures.js';

describe('command presentation', () => {
  it('start 首屏展示版本、意图、目录、SPEC 与权限', () => {
    const lines = renderCommandHeader(
      {
        kind: 'start',
        specPath: 'docs/SPEC.md',
        fullAccess: false,
        claudeCliPath: null,
        gitCliPath: null,
        pushRemote: null,
        verbose: false,
      },
      { agentVersion: '2.0.21', cwd: 'C:/repo' },
    );

    expect(lines).toEqual([
      'ApexCodingAgent 2.0.21',
      '',
      '◆ 开始新运行',
      '  目录 C:/repo',
      '  SPEC docs/SPEC.md',
      '  权限 自动',
    ]);
  });

  it('resume 与 abandon 首屏明确表达破坏性显式选项', () => {
    expect(
      renderCommandHeader(
        {
          kind: 'resume',
          fullAccess: true,
          force: true,
          claudeCliPath: null,
          gitCliPath: null,
          verbose: false,
        },
        { agentVersion: '2.0.21', cwd: 'C:/repo' },
      ),
    ).toContain('  方式 强制接管');
    expect(
      renderCommandHeader(
        { kind: 'abandon', force: false },
        { agentVersion: '2.0.21', cwd: 'C:/repo' },
      ),
    ).toContain('  方式 等待 --force 确认');
  });

  it('五类成功结果使用统一终态块并保留各自关键事实', () => {
    const completed = mkRun({
      status: 'completed',
      reportPath: 'report.md',
      terminalAt: T1,
    });
    const abandoned = mkRun({ status: 'abandoned', terminalAt: T1 });

    expect(renderCommandSuccess({ kind: 'start', run: completed })).toEqual([
      '',
      '✓ 运行完成',
      `  Run ${RUN_ID}`,
      '  报告 report.md',
    ]);
    expect(renderCommandSuccess({ kind: 'status', run: completed })).toContain(
      `  Run ${RUN_ID} · 计划版本 ${completed.planRevision}`,
    );
    expect(
      renderCommandSuccess({ kind: 'report', runId: RUN_ID, reportPath: 'report.md' }),
    ).toContain('✓ 报告生成完成');
    expect(renderCommandSuccess({ kind: 'abandon', run: abandoned })).toContain(
      '⊘ 运行已放弃',
    );
  });

  it('命令错误与已持久化 Run 失败共享结论优先层级', () => {
    const error = new ApexError({
      code: 'SPEC_NOT_FOUND',
      stage: 'spec-discovery',
      message: 'missing SPEC',
    });
    expect(renderCommandError('start', error)).toEqual([
      '',
      '✗ 开始新运行失败 · SPEC_NOT_FOUND',
      '  类型 startup_validation · 阶段 spec-discovery',
      '  原因 missing SPEC',
    ]);
    expect(
      renderRunCommandFailure({
        kind: 'resume',
        runId: RUN_ID,
        error: {
          errorCode: 'RUN_INTERRUPTED',
          stage: 'execution',
          message: 'interrupted',
        },
      }),
    ).toEqual([
      '',
      '◇ 恢复运行已中断 · RUN_INTERRUPTED',
      `  Run ${RUN_ID}`,
      '  阶段 execution',
      '  原因 interrupted',
    ]);
  });

  it('成功摘要拒绝与领域终态矛盾的用例返回值', () => {
    /*
     * 呈现层不能用破折号或默认文案掩盖非法状态；异常会由 run.ts 的命令
     * 错误边界转成稳定失败，避免同时向用户宣告成功和缺少报告。
     */
    expect(() =>
      renderCommandSuccess({ kind: 'start', run: mkRun({ status: 'planning' }) }),
    ).toThrow('invalid run status/report');
  });
});

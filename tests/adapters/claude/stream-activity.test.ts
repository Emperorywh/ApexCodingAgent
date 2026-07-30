/**
 * summarizeStreamEvent 测试：stream-json 事件 → 单行人类可读摘要。
 * 摘要只用于前台进度展示：无法摘要的事件返回 null，字段缺失不得抛错。
 */
import { describe, expect, it } from 'vitest';
import {
  createClaudeStreamCollector,
  describeStreamEvent,
  summarizeStreamEvent,
} from '../../../src/adapters/claude/stream-parser.js';

describe('summarizeStreamEvent', () => {
  it('assistant 思考块摘要为 thinking 行', () => {
    const summary = summarizeStreamEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '先读取 SPEC 理解需求' }] },
    });
    expect(summary).toBe('thinking: 先读取 SPEC 理解需求');
  });

  it('assistant 文本块原样摘要（折叠为单行）', () => {
    const summary = summarizeStreamEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '第一行\n第二行' }] },
    });
    expect(summary).toBe('第一行 第二行');
  });

  it('tool_use 优先使用最具辨识度的输入字段', () => {
    expect(
      summarizeStreamEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
    ).toBe('tool: Bash — npm test');
    expect(
      summarizeStreamEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'docs/SPEC.md' } },
          ],
        },
      }),
    ).toBe('tool: Read — docs/SPEC.md');
    expect(
      summarizeStreamEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'TaskList', input: {} }] },
      }),
    ).toBe('tool: TaskList');
  });

  it('user 事件的 tool_result 摘要；错误结果显式标注', () => {
    expect(
      summarizeStreamEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok\n12 tests passed' }] },
      }),
    ).toBe('tool result: ok 12 tests passed');
    expect(
      summarizeStreamEvent({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              is_error: true,
              content: [{ type: 'text', text: 'command failed' }],
            },
          ],
        },
      }),
    ).toBe('tool result (error): command failed');
  });

  it('多块内容以分隔符合并为一行', () => {
    const summary = summarizeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '准备修改配置' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/config.ts' } },
        ],
      },
    });
    expect(summary).toBe('准备修改配置 | tool: Edit — src/config.ts');
  });

  it('system / result 事件给出类型摘要，未知类型返回 null', () => {
    expect(summarizeStreamEvent({ type: 'system', subtype: 'init' })).toBe('system: init');
    expect(summarizeStreamEvent({ type: 'result', subtype: 'success' })).toBe(
      'result event received',
    );
    expect(summarizeStreamEvent({ type: 'rate_limit_event' })).toBeNull();
  });

  it('字段缺失或为空时返回 null 而不抛错', () => {
    expect(summarizeStreamEvent({ type: 'assistant' })).toBeNull();
    expect(summarizeStreamEvent({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(
      summarizeStreamEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '   ' }] },
      }),
    ).toBeNull();
  });

  it('超长内容折叠后截断到 200 字符并加省略号', () => {
    const summary = summarizeStreamEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'x'.repeat(500) }] },
    });
    expect(summary).not.toBeNull();
    expect(summary!.endsWith('…')).toBe(true);
    expect(summary!.length).toBeLessThanOrEqual(201);
  });

  it('结构化事件保留工具类别、名称与详情', () => {
    expect(
      describeStreamEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'docs/SPEC.md' } }],
        },
      }),
    ).toEqual([{ kind: 'tool', label: 'Read', detail: 'docs/SPEC.md' }]);
  });

  it('同一 stdout chunk 内的多个完整事件逐个上报', () => {
    const activities: string[] = [];
    const collector = createClaudeStreamCollector({
      sessionId: 'session-1',
      onActivity: (activity) => {
        const event = activity.displayEvent;
        if (event !== null) activities.push(`${event.sequence}:${event.detail ?? event.label}`);
      },
    });
    /*
     * 操作系统可以把多行合并为一个 chunk。该用例锁定“事件粒度回调”
     * 契约，防止终端再次只显示 chunk 中的最后一个动作。
     */
    collector.push(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] },
        })}\n${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'b.ts' } }] },
        })}\n`,
      ),
    );

    expect(activities).toEqual(['1:a.ts', '2:b.ts']);
  });

  it('高频 thinking 遥测只返回聚合分类，不驱动有效进度', () => {
    const activities: number[] = [];
    const collector = createClaudeStreamCollector({
      sessionId: 'session-1',
      onActivity: (activity) => activities.push(activity.relevantEventCount),
    });
    const encoder = new TextEncoder();

    /*
     * 遥测记录仍先经过 JSON 解析和 Session ID 检查，但不生成展示事件；
     * 后续真实工具事件从 1 开始计数，证明原始吞吐不会膨胀用户进度。
     */
    expect(
      collector.push(
        encoder.encode(
          `${JSON.stringify({
            type: 'system',
            subtype: 'thinking_tokens',
            estimated_tokens: 123,
            session_id: 'session-1',
          })}\n`,
        ),
      ),
    ).toEqual([{ kind: 'telemetry', category: 'system/thinking' }]);
    expect(activities).toEqual([]);

    collector.push(
      encoder.encode(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Read', input: { path: 'src/index.ts' } }],
          },
        })}\n`,
      ),
    );
    expect(activities).toEqual([1]);
  });

  it('展示摘要会移除外部 ANSI 控制序列', () => {
    const [event] = describeStreamEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: '\u001B[1mRead\u001B[0m', input: { path: 'a.ts' } }],
      },
    });
    expect(event).toEqual({ kind: 'tool', label: 'Read', detail: 'a.ts' });
  });
});

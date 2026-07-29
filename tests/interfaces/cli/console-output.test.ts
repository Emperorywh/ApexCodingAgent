/**
 * 终端最后一道呈现边界测试。
 *
 * 外部 ANSI 不得穿透到用户终端；非 TTY 输出必须保持纯文本，便于 CI、
 * 重定向文件和脚本稳定消费。TTY 颜色只验证语义符号触发，不绑定具体颜色
 * 码实现细节。
 */
import { describe, expect, it } from 'vitest';
import {
  formatConsoleText,
  sanitizeConsoleText,
} from '../../../src/interfaces/cli/console-output.js';

describe('console output', () => {
  it('移除外部 ANSI 与可改写当前行的控制字符', () => {
    const text = '\u001B[1m模型 k3\u001B[0m\r伪造前缀';
    expect(sanitizeConsoleText(text)).toBe('模型 k3伪造前缀');
  });

  it('非 TTY 格式化保持纯文本且保留帮助文本换行', () => {
    const text = '✓ 完成\n  详情';
    expect(formatConsoleText(text, false)).toBe(text);
  });

  it('TTY 模式只添加 Apex 自己的颜色序列', () => {
    const rendered = formatConsoleText('✓ 完成', true);
    expect(rendered).toContain('✓ 完成');
    expect(rendered).toContain('\u001B[');
  });
});

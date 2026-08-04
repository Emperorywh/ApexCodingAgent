/**
 * 终端最后一道呈现边界测试。
 *
 * 外部 ANSI 不得穿透到用户终端；非 TTY 输出必须保持纯文本，便于 CI、
 * 重定向文件和脚本稳定消费。TTY 颜色只验证语义符号触发，不绑定具体颜色
 * 码实现细节。
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  createConsolePresenter,
  formatConsoleText,
  sanitizeConsoleText,
  type InteractiveConsoleStream,
} from '../../../src/interfaces/cli/console-output.js';

/** 创建带可控 TTY 事实的内存流，避免测试接触真实终端。 */
function createMemoryStream(isTTY: boolean): {
  readonly stream: InteractiveConsoleStream;
  readonly read: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  Object.defineProperties(stream, {
    isTTY: { value: isTTY },
    columns: { value: 80 },
    rows: { value: 24 },
  });
  return {
    stream: stream as InteractiveConsoleStream,
    read: () => chunks.join(''),
  };
}

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
    /**
     * 颜色现在只包裹语义图标，避免长任务行整行着色。
     *
     * 移除终端样式后必须无损恢复原始文本，确保颜色不承载业务含义。
     */
    expect(sanitizeConsoleText(rendered)).toBe('✓ 完成');
    expect(rendered).toContain('\u001B[');
  });

  it('非 TTY 状态更新保持逐行纯文本，不发送光标控制序列', () => {
    const stdout = createMemoryStream(false);
    const stderr = createMemoryStream(false);
    const presenter = createConsolePresenter({
      stdout: stdout.stream,
      stderr: stderr.stream,
      colorEnabled: true,
    });

    presenter.updateStatus('  … 已运行 15s');
    presenter.updateStatus('  … 已运行 30s');
    presenter.clearStatus();

    expect(stdout.read()).toBe('  … 已运行 15s\n  … 已运行 30s\n');
    expect(stdout.read()).not.toContain('\u001B[');
  });

  it('TTY 状态使用可替换活动区域，并允许永久行写入滚动历史', () => {
    const stdout = createMemoryStream(true);
    const stderr = createMemoryStream(true);
    const presenter = createConsolePresenter({
      stdout: stdout.stream,
      stderr: stderr.stream,
      colorEnabled: false,
    });

    /*
     * 原始缓冲会保留 log-update 发出的光标指令；真实终端应用这些指令后只
     * 显示最新状态，而 persist 写入的完成事实仍可在滚动历史中找到。
     */
    presenter.updateStatus('  … 第一状态');
    presenter.updateStatus('  … 第二状态');
    presenter.writeStdout('✓ 永久事实');
    presenter.clearStatus();

    const raw = stdout.read();
    expect(raw).toContain('\u001B[');
    expect(raw).toContain('第二状态');
    expect(raw).toContain('✓ 永久事实');
  });
});

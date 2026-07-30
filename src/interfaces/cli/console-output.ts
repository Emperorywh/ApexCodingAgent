/**
 * 真实终端 Sink 的最后一道呈现边界。
 *
 * 所有动态文本先移除外部工具可能夹带的 ANSI/VT 控制序列，再按 TTY 能力
 * 添加 Apex 自己的轻量颜色。重定向到文件或管道时保持纯文本，既方便机器
 * 处理，也避免把颜色码写进 CI 日志。
 */
import { stripVTControlCharacters, styleText } from 'node:util';

export interface ConsoleOutputStream {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/**
 * 清理 ANSI 之外的危险单行控制字符。
 *
 * 帮助文本需要保留换行和制表符，因此这里只移除可能改写当前终端行或注入
 * 不可见状态的其余 C0/C1 字符。
 */
export function sanitizeConsoleText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

/**
 * 为已经确认支持颜色的终端应用样式。
 *
 * `styleText` 默认会再次检查当前进程 stdout；stderr 或测试注入的 TTY
 * 会因此被误判。TTY/NO_COLOR 已由 writeConsoleText 统一裁决，所以这里
 * 关闭重复校验，保证 stdout 与 stderr 的呈现规则一致。
 */
function applyStyle(
  format: Parameters<typeof styleText>[0],
  text: string,
): string {
  return styleText(format, text, { validateStream: false });
}

/**
 * 只为行首语义图标着色，避免任务列表整行铺满高饱和颜色。
 *
 * 缩进必须原样保留；图标只是视觉增强，移除 ANSI 后仍是完整纯文本。
 */
function styleLeadingIcon(
  line: string,
  format: Parameters<typeof styleText>[0],
): string {
  const iconIndex = line.search(/\S/);
  if (iconIndex < 0) return line;
  return (
    line.slice(0, iconIndex) +
    applyStyle(format, line[iconIndex]!) +
    line.slice(iconIndex + 1)
  );
}

/**
 * 根据语义符号为单行添加克制的 TTY 颜色。
 *
 * 产品标题和区块标题使用整行强调；状态行只强调图标，使长任务列表仍保持
 * 清晰层级，并避免“全部完成”场景出现大面积绿色文本。
 */
function styleConsoleLine(line: string): string {
  const trimmed = line.trimStart();
  if (line.startsWith('ApexCodingAgent ')) {
    return applyStyle('cyan', applyStyle('bold', line));
  }
  if (
    trimmed.startsWith('警告：') ||
    trimmed.startsWith('风险提示：')
  ) {
    return applyStyle('yellow', line);
  }
  if (trimmed.startsWith('◆')) return applyStyle('cyan', line);
  if (trimmed.startsWith('✓')) return styleLeadingIcon(line, 'green');
  if (trimmed.startsWith('✗') || trimmed.startsWith('!')) {
    return styleLeadingIcon(line, 'red');
  }
  if (trimmed.startsWith('⚠')) return styleLeadingIcon(line, 'yellow');
  if (trimmed.startsWith('◇')) return styleLeadingIcon(line, 'cyan');
  if (trimmed.startsWith('↻')) return styleLeadingIcon(line, 'magenta');
  if (trimmed.startsWith('→')) return styleLeadingIcon(line, 'blue');
  if (trimmed.startsWith('…') || trimmed.startsWith('⊘')) {
    return styleLeadingIcon(line, 'gray');
  }
  return line;
}

/**
 * 格式化一段可能包含多行的控制台文本。
 *
 * `NO_COLOR` 的判断由调用方折算进 useColor，保持本模块纯粹且便于测试。
 */
export function formatConsoleText(text: string, useColor: boolean): string {
  const safe = sanitizeConsoleText(text);
  return useColor ? safe.split('\n').map(styleConsoleLine).join('\n') : safe;
}

/** 写入真实 stdout/stderr，并统一补齐末尾换行。 */
export function writeConsoleText(
  stream: ConsoleOutputStream,
  text: string,
  colorEnabled: boolean,
): void {
  const rendered = formatConsoleText(text, colorEnabled && stream.isTTY === true);
  stream.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
}

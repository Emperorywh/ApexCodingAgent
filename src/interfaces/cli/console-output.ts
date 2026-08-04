/**
 * 真实终端 Sink 的最后一道呈现边界。
 *
 * 所有动态文本先移除外部工具可能夹带的 ANSI/VT 控制序列，再按 TTY 能力
 * 添加 Apex 自己的轻量颜色。重定向到文件或管道时保持纯文本，既方便机器
 * 处理，也避免把颜色码写进 CI 日志。
 */
import { stripVTControlCharacters, styleText } from 'node:util';
import { createLogUpdate } from 'log-update';

export interface ConsoleOutputStream {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/**
 * `log-update` 需要真实可写流及终端尺寸事实。
 *
 * 该类型只存在于 Interface 层，不会沿 Composition Root 进入 Application；
 * Node 的 stdout/stderr 直接满足契约，测试则可注入内存 Writable。
 */
export type InteractiveConsoleStream = NodeJS.WritableStream & {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
};

export interface ConsolePresenter {
  /** 写入 stdout 的永久内容；活动状态存在时会先让出终端区域。 */
  writeStdout(text: string): void;
  /** 写入 stderr 的永久内容；不会破坏 stdout 上的活动状态。 */
  writeStderr(text: string): void;
  /** 创建或替换底部唯一活动状态。 */
  updateStatus(text: string): void;
  /** 清理活动状态与动画计时器。 */
  clearStatus(): void;
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

/**
 * Claude Code 风格的低频呼吸动画。
 *
 * 帧只负责表达“仍在活动”，状态正文仍由 Application 生成；复杂的光标移动、
 * ANSI 宽度计算和 Windows 终端换行全部交给 log-update，避免在项目内维护
 * 一套易出错的终端状态机。
 */
const LIVE_FRAMES = ['✻', '✽', '✶', '✳', '✢', '·', '✢', '✳', '✶', '✽'] as const;
const LIVE_FRAME_INTERVAL_MS = 90;

/** 把 Application 的稳定省略号标记替换为当前动画帧。 */
function formatLiveStatus(text: string, frame: string, useColor: boolean): string {
  const safe = sanitizeConsoleText(text);
  const match = /^(\s*)…(?:\s+|$)(.*)$/s.exec(safe);
  if (match === null) return formatConsoleText(safe, useColor);

  const indentation = match[1] ?? '';
  const detail = match[2] ?? '';
  const renderedFrame = useColor ? applyStyle('magenta', frame) : frame;
  return `${indentation}${renderedFrame}${detail === '' ? '' : ` ${detail}`}`;
}

/**
 * 创建进程级控制台呈现器。
 *
 * 交互式 stdout 使用一个可替换的底部区域：永久 stdout 行通过 persist 写入
 * 滚动历史，stderr 写入前则暂时清空再恢复。非 TTY/CI 不发送任何光标控制
 * 序列，状态更新逐行落地，继续保留可审计的纯文本进度。
 */
export function createConsolePresenter(options: {
  readonly stdout: InteractiveConsoleStream;
  readonly stderr: InteractiveConsoleStream;
  readonly colorEnabled: boolean;
}): ConsolePresenter {
  const interactive = options.stdout.isTTY === true;
  const liveRenderer = interactive
    ? createLogUpdate(options.stdout, { showCursor: true })
    : null;
  let liveText: string | null = null;
  let frameIndex = 0;
  let animationTimer: NodeJS.Timeout | null = null;

  function renderLiveStatus(): void {
    if (liveRenderer === null || liveText === null) return;
    const frame = LIVE_FRAMES[frameIndex % LIVE_FRAMES.length]!;
    liveRenderer(formatLiveStatus(liveText, frame, options.colorEnabled));
  }

  function startAnimation(): void {
    if (animationTimer !== null) return;
    animationTimer = setInterval(() => {
      frameIndex = (frameIndex + 1) % LIVE_FRAMES.length;
      renderLiveStatus();
    }, LIVE_FRAME_INTERVAL_MS);
    /*
     * 动画只是呈现增强，绝不能让已完成的 CLI 进程继续存活。
     * Session 正常/失败/中断收尾仍会显式 clearStatus，这里是进程级安全兜底。
     */
    animationTimer.unref();
  }

  function pauseLiveStatus(): boolean {
    if (liveRenderer === null || liveText === null) return false;
    liveRenderer.clear();
    return true;
  }

  function resumeLiveStatus(shouldResume: boolean): void {
    if (shouldResume) renderLiveStatus();
  }

  return {
    writeStdout(text) {
      if (liveRenderer !== null && liveText !== null) {
        /*
         * persist 会原子清除旧活动区域并把稳定内容写入滚动历史。
         * 随后立即恢复同一状态，工具动作不会把动态行留成重复历史。
         */
        liveRenderer.persist(formatConsoleText(text, options.colorEnabled));
        renderLiveStatus();
        return;
      }
      writeConsoleText(options.stdout, text, options.colorEnabled);
    },
    writeStderr(text) {
      const shouldResume = pauseLiveStatus();
      writeConsoleText(options.stderr, text, options.colorEnabled);
      resumeLiveStatus(shouldResume);
    },
    updateStatus(text) {
      if (liveRenderer === null) {
        writeConsoleText(options.stdout, text, options.colorEnabled);
        return;
      }
      liveText = text;
      renderLiveStatus();
      startAnimation();
    },
    clearStatus() {
      if (animationTimer !== null) {
        clearInterval(animationTimer);
        animationTimer = null;
      }
      if (liveRenderer !== null && liveText !== null) {
        liveRenderer.clear();
        liveRenderer.done();
      }
      liveText = null;
      frameIndex = 0;
    },
  };
}

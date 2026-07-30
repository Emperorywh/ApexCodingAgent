/**
 * 脱敏规则唯一事实源（SPEC §18.4、NFR-006）。
 *
 * 每条规则同时声明完整匹配正则与 `maxMatchLength`。完整文本直接顺序应用
 * 这些规则；流式实现则从同一份长度上限推导重叠窗口，不再维护容易与完整
 * 规则漂移的第二套“未完成前缀”正则。
 *
 * 所有量词必须显式有界：脱敏是降低意外持久化风险的检测机制，不是绝对的
 * 凭据发现保证。每条新增规则仍必须在集中语料中添加回归样本，否则
 * NFR-006 语料测试会失败。
 */
import { REDACTED_PLACEHOLDER } from '../../application/ports/redaction.js';

export interface RedactionRule {
  readonly name: string;
  /** Global pattern; applied sequentially to the whole text. */
  readonly pattern: RegExp;
  readonly replacement: string | ((...args: string[]) => string);
  /**
   * 单次完整匹配的字符数上限。
   *
   * 流式实现以全部规则的最大值建立安全重叠窗口，因此该值是正确性契约，
   * 不能只按语料中的常见长度估算。
   */
  readonly maxMatchLength: number;
  /**
   * 已应用完整规则后，判断剩余文本是否仍含有可跨逻辑记录继续匹配的起点。
   *
   * 仅真正允许跨记录的规则需要提供；该判定与完整正则放在同一规则对象中，
   * 防止流式边界协议再次形成独立且容易漂移的规则表。
   */
  readonly blocksRecordBoundary?: (redactedText: string) => boolean;
}

/** Replacement for `sensitive-field`: keeps name, separator and quote style. */
function redactSensitiveFieldValue(
  match: string,
  openQuote: string,
  name: string,
  closeQuote: string,
  separator: string,
  value: string,
): string {
  void match;
  let redactedValue = REDACTED_PLACEHOLDER;
  if (value.startsWith('"')) redactedValue = `"${REDACTED_PLACEHOLDER}"`;
  else if (value.startsWith("'")) redactedValue = `'${REDACTED_PLACEHOLDER}'`;
  /*
   * JSON.stringify 生成的属性名始终使用双引号。原值是数字、布尔或 null
   * 时也必须补上字符串引号，避免文本级纵深防御破坏 JSONL 语法。
   */
  else if (openQuote === '"' && closeQuote === '"') {
    redactedValue = `"${REDACTED_PLACEHOLDER}"`;
  }
  return `${openQuote}${name}${closeQuote}${separator}${redactedValue}`;
}

const PRIVATE_KEY_LABEL = '[A-Z0-9 ]{0,64}';
const PRIVATE_KEY_OPEN_PATTERN = new RegExp(
  `-----BEGIN ${PRIVATE_KEY_LABEL}PRIVATE KEY-----`,
);

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    name: 'private-key-block',
    pattern: new RegExp(
      `-----BEGIN ${PRIVATE_KEY_LABEL}PRIVATE KEY-----[\\s\\S]{0,8192}?-----END ${PRIVATE_KEY_LABEL}PRIVATE KEY-----`,
      'g',
    ),
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 8372,
    blocksRecordBoundary: (redactedText) => PRIVATE_KEY_OPEN_PATTERN.test(redactedText),
  },
  {
    name: 'authorization-header',
    pattern: /\b((?:Proxy-)?Authorization[ \t]{0,64}:[ \t]{0,64})[^\r\n]{0,2048}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 2196,
  },
  {
    name: 'cookie-header',
    pattern: /\b((?:Set-)?Cookie[ \t]{0,64}:[ \t]{0,64})[^\r\n]{0,4096}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 4235,
  },
  {
    name: 'credential-url',
    pattern: /\b([a-z][a-z0-9+.-]{0,32}):\/\/[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi,
    replacement: `$1://${REDACTED_PLACEHOLDER}@`,
    maxMatchLength: 550,
  },
  {
    name: 'bearer-token',
    pattern: /\b(Bearer[ \t]{1,64})[A-Za-z0-9._~+/=-]{8,512}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 582,
  },
  {
    name: 'basic-token',
    pattern: /\b(Basic[ \t]{1,64})[A-Za-z0-9+/=]{16,512}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 581,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,1024}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 3077,
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 20,
  },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 266,
  },
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,512}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 520,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 260,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 39,
  },
  {
    name: 'stripe-key',
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,255}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 263,
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 40,
  },
  {
    name: 'sensitive-field',
    /**
     * 字段名两侧引号彼此独立可选，不要求使用反向引用；这样既覆盖 JSON /
     * YAML / 环境变量形式，也让字段名和分隔符的所有量词保持显式有界。
     *
     * 未加引号的值排除 JSON 容器结束符，防止 `null}` 一类输入在替换时吞掉
     * 右花括号；固定占位符单列为完整备选以保持幂等，避免右方括号被误认为
     * 容器结束符而残留；api_key/api-key、passphrase、credential 也纳入词典。
     */
    pattern:
      /(["']?)([A-Za-z0-9_.-]{0,64}(?:token|secret|password|passphrase|credential|api[_-]?key|authorization)[A-Za-z0-9_.-]{0,64})(["']?)([ \t]{0,64}[:=][ \t]{0,64})(\[REDACTED\]|"[^"]{0,4096}"|'[^']{0,4096}'|(?:Bearer|Basic)[ \t]{1,64}[^\s,;&}\]]{1,512}|[^\s,;&}\]]{1,512})/gi,
    replacement: redactSensitiveFieldValue as (...args: string[]) => string,
    maxMatchLength: 4370,
  },
];

/**
 * 全部规则的最大完整匹配长度。
 *
 * 该值由规则表自动推导，是流式重叠窗口的唯一来源；新增或扩大规则时无需
 * 再同步维护另一张前缀表。
 */
export const MAX_REDACTION_MATCH_LENGTH = Math.max(
  ...REDACTION_RULES.map((rule) => rule.maxMatchLength),
);

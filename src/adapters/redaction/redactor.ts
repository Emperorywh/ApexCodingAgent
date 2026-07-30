/**
 * RedactionPort 实现（SPEC §18.4、NFR-006）：完整文本规则、保持 JSON
 * 类型的结构化脱敏，以及与任意 chunk 边界无关的流式脱敏。
 *
 * 流式正确性只依赖完整规则声明的最大匹配长度：始终保留至少一个最大匹配
 * 窗口，任何尚未闭合、未来可能成为秘密的前缀都不可能落到安全切点之前；
 * 已完整但跨越切点的匹配会把切点回退到自身起点。这样无需维护第二套
 * “危险尾部”规则，也就不会因两套正则漂移而产生分块绕过。
 */
import {
  REDACTED_PLACEHOLDER,
  type ChunkRedactionScope,
  type ChunkRedactor,
  type RedactionAudit,
  type RedactionPort,
} from '../../application/ports/redaction.js';
import { REDACTION_RULES, type RedactionRule } from './redaction-rules.js';

/** Field names whose values are wholesale-redacted (SPEC §18.4). */
export const SENSITIVE_FIELD_NAME =
  /token|secret|password|passphrase|credential|api[_-]?key|authorization/i;

const CONTROL_SEQUENCE_RULE_NAME = 'control-sequence';

interface MutableAudit {
  matchCount: number;
  readonly matchedRules: Set<string>;
}

/**
 * 在凭据规则之前统一清除 ANSI/VT 与危险控制字符。
 *
 * 控制序列如果晚于脱敏才移除，攻击者可以把一个 Token 拆成多个正则不可见
 * 片段，并在终端清理阶段重新拼接；因此规范化属于 Redactor 自身的前置步骤。
 */
function normalizeExternalText(text: string, audit?: MutableAudit): string {
  /*
   * 完整文本与 chunk 流复用同一状态机；这既覆盖普通 ANSI，也会安全丢弃
   * 未闭合 OSC/DCS，避免两套规范化语义随时间漂移。
   */
  const normalizer = createStreamingControlSequenceNormalizer();
  const normalized = normalizer.push(text) + normalizer.flush();
  if (audit !== undefined && normalized !== text) {
    audit.matchCount += 1;
    audit.matchedRules.add(CONTROL_SEQUENCE_RULE_NAME);
  }
  return normalized;
}

type ControlSequenceState =
  | 'text'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'control-string'
  | 'control-string-escape';

interface StreamingControlSequenceNormalizer {
  push(chunk: string): string;
  flush(): string;
}

/**
 * 创建跨 chunk 的 ANSI/VT 控制序列规范化器。
 *
 * 一次性 stripVTControlCharacters 无法识别被 OS 分在两个 chunk 的序列；
 * 这里以显式状态消费 CSI、OSC、DCS 等序列，并清除危险 C0/C1 字符。普通
 * 文本立即返回，未闭合控制字符串在流结束时整体丢弃，不回显其内部内容。
 */
function createStreamingControlSequenceNormalizer(): StreamingControlSequenceNormalizer {
  let state: ControlSequenceState = 'text';

  function push(chunk: string): string {
    let output = '';
    for (const character of chunk) {
      const codePoint = character.codePointAt(0) ?? 0;

      if (state === 'control-string') {
        if (character === '\u0007') state = 'text';
        else if (character === '\u001b') state = 'control-string-escape';
        continue;
      }
      if (state === 'control-string-escape') {
        if (character === '\\') state = 'text';
        else if (character !== '\u001b') state = 'control-string';
        continue;
      }
      if (state === 'csi') {
        if (codePoint >= 0x40 && codePoint <= 0x7e) state = 'text';
        else if (character === '\u001b') state = 'escape';
        continue;
      }
      if (state === 'escape-intermediate') {
        if (codePoint >= 0x30 && codePoint <= 0x7e) state = 'text';
        else if (character === '\u001b') state = 'escape';
        continue;
      }
      if (state === 'escape') {
        if (character === '[') state = 'csi';
        else if (character === ']' || character === 'P' || character === 'X' ||
          character === '^' || character === '_') {
          state = 'control-string';
        } else if (codePoint >= 0x20 && codePoint <= 0x2f) {
          state = 'escape-intermediate';
        } else if (character === '\u001b') {
          state = 'escape';
        } else if (codePoint >= 0x30 && codePoint <= 0x7e) {
          state = 'text';
        } else {
          /*
           * ESC 后的非 ANSI Unicode 字符不属于控制序列；只丢弃 ESC，
           * 保留该字符参与凭据检测，避免过度删除正常诊断内容。
           */
          state = 'text';
          output += character;
        }
        continue;
      }

      if (character === '\u001b') {
        state = 'escape';
      } else if (codePoint === 0x9b) {
        state = 'csi';
      } else if (
        codePoint === 0x90 ||
        codePoint === 0x98 ||
        codePoint === 0x9d ||
        codePoint === 0x9e ||
        codePoint === 0x9f
      ) {
        state = 'control-string';
      } else if (
        (codePoint >= 0 && codePoint <= 0x08) ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      ) {
        // 危险 C0/C1 控制字符不进入任何后续 Sink。
      } else {
        output += character;
      }
    }
    return output;
  }

  function flush(): string {
    /*
     * 状态内只保留控制序列语法，不保留普通文本；结束时重置即可安全丢弃
     * 未闭合序列，且下一次误用不会继承旧状态。
     */
    state = 'text';
    return '';
  }

  return { push, flush };
}

function applyRules(
  text: string,
  rules: readonly RedactionRule[] = REDACTION_RULES,
  audit?: MutableAudit,
): string {
  let out = normalizeExternalText(text, audit);
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (audit !== undefined) {
      const matches = out.match(rule.pattern);
      if (matches !== null) {
        audit.matchCount += matches.length;
        audit.matchedRules.add(rule.name);
      }
      rule.pattern.lastIndex = 0;
    }
    out = out.replace(rule.pattern, rule.replacement as string);
  }
  return out;
}

/**
 * 判断完整规则处理后是否仍有跨逻辑记录延续的匹配。
 *
 * 多行私钥等规则不能因一条 JSON 记录结束就提前排出；其他规则则可利用
 * 已验证的记录边界降低日志延迟。
 */
function blocksRecordBoundary(
  redactedText: string,
  rules: readonly RedactionRule[],
): boolean {
  return rules.some(
    (rule) => rule.blocksRecordBoundary?.(redactedText) === true,
  );
}

/**
 * 计算当前原始缓冲区的安全切点。
 *
 * 初始切点保留一个完整的最大匹配窗口；如果某个已完成匹配跨越切点，则把
 * 整个匹配留到下一轮。循环用于处理多个规则的跨界匹配发生重叠的情况。
 */
function findSafeCut(
  text: string,
  rules: readonly RedactionRule[],
  maxMatchLength: number,
): number {
  let cut = text.length - maxMatchLength;
  if (cut <= 0) return 0;

  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (
        let match = rule.pattern.exec(text);
        match !== null;
        match = rule.pattern.exec(text)
      ) {
        if (match[0].length === 0) break;
        const start = match.index;
        const end = start + match[0].length;
        if (start < cut && cut < end) {
          cut = start;
          changed = true;
        }
      }
    }
  }
  return cut;
}

function createChunkRedactor(scope: ChunkRedactionScope): ChunkRedactor {
  const rules =
    scope === 'all'
      ? REDACTION_RULES
      : REDACTION_RULES.filter((rule) => rule.blocksRecordBoundary !== undefined);
  const maxMatchLength = Math.max(...rules.map((rule) => rule.maxMatchLength));
  /**
   * 缓冲达到两个重叠窗口后才批量排出安全前缀。
   *
   * 第二个窗口不是正确性所必需，而是避免极小 chunk 每次都对同一段尾部
   * 重复扫描；这同时把常驻原始文本限制在一个很小的有界范围内。
   */
  const drainThreshold = maxMatchLength * 2;
  const controlNormalizer = createStreamingControlSequenceNormalizer();
  let pending = '';
  return {
    push(chunk: string): string {
      /*
       * 控制序列规范化器自身保留解析状态，ANSI 序列与凭据都可以跨任意
       * chunk 边界；进入凭据窗口的 pending 已不含可被终端重新解释的字节。
       */
      pending += controlNormalizer.push(chunk);
      if (pending.length <= drainThreshold) return '';
      const cut = findSafeCut(pending, rules, maxMatchLength);
      if (cut === 0) return '';
      const out = applyRules(pending.slice(0, cut), rules);
      pending = pending.slice(cut);
      return out;
    },
    flushRecordBoundary(): string {
      const out = applyRules(pending, rules);
      if (blocksRecordBoundary(out, rules)) return '';
      pending = '';
      return out;
    },
    flush(): string {
      pending += controlNormalizer.flush();
      const out = applyRules(pending, rules);
      pending = '';
      return out;
    },
  };
}

function redactStructuredValue(
  value: unknown,
  keyIsSensitive: boolean,
  audit?: MutableAudit,
): unknown {
  if (typeof value === 'string') {
    if (keyIsSensitive) {
      if (audit !== undefined) {
        audit.matchCount += 1;
        audit.matchedRules.add('sensitive-field');
      }
      return REDACTED_PLACEHOLDER;
    }
    return applyRules(value, REDACTION_RULES, audit);
  }
  if (keyIsSensitive && typeof value === 'number') {
    if (audit !== undefined) {
      audit.matchCount += 1;
      audit.matchedRules.add('sensitive-field');
    }
    return 0;
  }
  if (keyIsSensitive && typeof value === 'boolean') {
    if (audit !== undefined) {
      audit.matchCount += 1;
      audit.matchedRules.add('sensitive-field');
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactStructuredValue(element, keyIsSensitive, audit));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactStructuredValue(
        nested,
        keyIsSensitive || SENSITIVE_FIELD_NAME.test(key),
        audit,
      );
    }
    return out;
  }
  /**
   * 敏感字段按 JSON 类型使用不可逆占位值：字符串、数字和布尔值分别替换为
   * 固定字符串、0 与 false；null 保持 null。敏感父对象的标记会向全部后代
   * 传播，从而既不泄露嵌套值，也不破坏持久化 Schema 所要求的类型。
   */
  return value;
}

export function createRedactor(): RedactionPort {
  return {
    redactText(text: string): string {
      return applyRules(text);
    },
    redactStructured<T>(value: T): T {
      return redactStructuredValue(value, false) as T;
    },
    redactStructuredWithAudit<T>(value: T) {
      /*
       * 审计集合在一次递归中聚合，最终按规则表顺序稳定输出；额外的控制序列
       * 类别放在末尾，日志分析不会因对象遍历顺序不同而产生无意义差异。
       */
      const audit: MutableAudit = { matchCount: 0, matchedRules: new Set<string>() };
      const redacted = redactStructuredValue(value, false, audit) as T;
      const orderedRuleNames = [
        ...REDACTION_RULES.map((rule) => rule.name),
        CONTROL_SEQUENCE_RULE_NAME,
      ];
      const resultAudit: RedactionAudit = {
        matchCount: audit.matchCount,
        matchedRules: orderedRuleNames.filter((name) => audit.matchedRules.has(name)),
      };
      return { value: redacted, audit: resultAudit };
    },
    createChunkRedactor,
  };
}

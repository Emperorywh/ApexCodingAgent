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
  type ChunkRedactor,
  type RedactionPort,
} from '../../application/ports/redaction.js';
import { MAX_REDACTION_MATCH_LENGTH, REDACTION_RULES } from './redaction-rules.js';

/** Field names whose values are wholesale-redacted (SPEC §18.4). */
export const SENSITIVE_FIELD_NAME = /token|secret|password|apiKey|authorization/i;

function applyRules(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0;
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
function blocksRecordBoundary(redactedText: string): boolean {
  return REDACTION_RULES.some(
    (rule) => rule.blocksRecordBoundary?.(redactedText) === true,
  );
}

/**
 * 计算当前原始缓冲区的安全切点。
 *
 * 初始切点保留一个完整的最大匹配窗口；如果某个已完成匹配跨越切点，则把
 * 整个匹配留到下一轮。循环用于处理多个规则的跨界匹配发生重叠的情况。
 */
function findSafeCut(text: string): number {
  let cut = text.length - MAX_REDACTION_MATCH_LENGTH;
  if (cut <= 0) return 0;

  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of REDACTION_RULES) {
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

function createChunkRedactor(): ChunkRedactor {
  /**
   * 缓冲达到两个重叠窗口后才批量排出安全前缀。
   *
   * 第二个窗口不是正确性所必需，而是避免极小 chunk 每次都对同一段尾部
   * 重复扫描；这同时把常驻原始文本限制在一个很小的有界范围内。
   */
  const drainThreshold = MAX_REDACTION_MATCH_LENGTH * 2;
  let pending = '';
  return {
    push(chunk: string): string {
      pending += chunk;
      if (pending.length <= drainThreshold) return '';
      const cut = findSafeCut(pending);
      if (cut === 0) return '';
      const out = applyRules(pending.slice(0, cut));
      pending = pending.slice(cut);
      return out;
    },
    flushRecordBoundary(): string {
      const out = applyRules(pending);
      if (blocksRecordBoundary(out)) return '';
      pending = '';
      return out;
    },
    flush(): string {
      const out = applyRules(pending);
      pending = '';
      return out;
    },
  };
}

function redactStructuredValue(value: unknown, keyIsSensitive: boolean): unknown {
  if (typeof value === 'string') {
    return keyIsSensitive ? REDACTED_PLACEHOLDER : applyRules(value);
  }
  if (keyIsSensitive && typeof value === 'number') {
    return 0;
  }
  if (keyIsSensitive && typeof value === 'boolean') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactStructuredValue(element, keyIsSensitive));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactStructuredValue(
        nested,
        keyIsSensitive || SENSITIVE_FIELD_NAME.test(key),
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
    createChunkRedactor,
  };
}

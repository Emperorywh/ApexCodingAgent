/**
 * RedactionPort implementation (SPEC §18.4, NFR-006): rule-engine text
 * redaction, type-preserving structured redaction, and a streaming chunk
 * redactor.
 *
 * Streaming correctness argument: the buffer is only emitted up to the
 * earliest position where a secret may still be in progress — a danger-suffix
 * match (INCOMPLETE_PATTERNS) or a complete match straddling the cut. Every
 * complete pattern either self-matches its own sufficiently long prefixes
 * (header values, bearer/basic tokens) or has a danger-suffix pattern
 * covering its proper prefixes (private key blocks, JWTs, credential URLs,
 * quoted sensitive-field values); short fixed-prefix tokens are covered by
 * the trailing-token-fragment holdback. Therefore a secret split across
 * chunks is redacted as a whole instead of leaking fragments.
 */
import {
  REDACTED_PLACEHOLDER,
  type ChunkRedactor,
  type RedactionPort,
} from '../../application/ports/redaction.js';
import { INCOMPLETE_PATTERNS, REDACTION_RULES } from './redaction-rules.js';

/** Field names whose values are wholesale-redacted (SPEC §18.4). */
export const SENSITIVE_FIELD_NAME = /token|secret|password|apiKey|authorization/i;

function applyRules(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replacement as string);
  }
  return out;
}

/**
 * Earliest buffer position where a secret may still be in progress; the
 * streaming redactor emits `[0, cut)` and keeps `[cut, end)`.
 */
function findSafeCut(text: string): number {
  let cut = text.length;
  for (const danger of INCOMPLETE_PATTERNS) {
    const match = danger.pattern.exec(text);
    if (match !== null && match.index < cut) {
      cut = match.index;
    }
  }
  // A complete match straddling the cut would be redacted only partially;
  // pull its start into the held-back region. Re-scan until stable because
  // moving the cut can reveal earlier straddling matches.
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
  let pending = '';
  return {
    push(chunk: string): string {
      pending += chunk;
      const cut = findSafeCut(pending);
      const out = applyRules(pending.slice(0, cut));
      pending = pending.slice(cut);
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
  if (Array.isArray(value)) {
    return value.map((element) => redactStructuredValue(element, keyIsSensitive));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactStructuredValue(nested, SENSITIVE_FIELD_NAME.test(key));
    }
    return out;
  }
  // Numbers, booleans and null are returned unchanged: only strings are
  // replaced (with a string placeholder), so JSON types and schema validity
  // survive redaction (SPEC §18.4).
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

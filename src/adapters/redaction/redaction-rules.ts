/**
 * Redaction rule table (SPEC §18.4, NFR-006).
 *
 * Two pattern families:
 * - {@link REDACTION_RULES}: complete patterns applied to any text. Every
 *   match is replaced with the fixed placeholder (values are never hashed,
 *   encoded or partially echoed); field/header names are kept so diagnostics
 *   stay meaningful.
 * - {@link INCOMPLETE_PATTERNS}: end-of-buffer "danger suffix" patterns used
 *   only by the streaming chunk redactor. Each one matches a proper prefix of
 *   a potential secret sitting at the tail of the pending buffer, so the
 *   streaming redactor holds it back instead of emitting a fragment that a
 *   later chunk would complete into a bypass (SPEC §18.4 overlap window).
 *
 * All quantifiers are bounded: redaction is a detection mechanism, not an
 * absolute credential-discovery guarantee (SPEC §18.4). `maxMatchLength`
 * documents each rule's bound; corpus secrets must stay within it.
 *
 * NFR-006: every rule here must have at least one regression sample in
 * `tests/fixtures/redaction-corpus/corpus.json`; adding a rule without a
 * sample fails the corpus test.
 */
import { REDACTED_PLACEHOLDER } from '../../application/ports/redaction.js';

export interface RedactionRule {
  readonly name: string;
  /** Global pattern; applied sequentially to the whole text. */
  readonly pattern: RegExp;
  readonly replacement: string | ((...args: string[]) => string);
  /** Upper bound on a single match length, in characters. */
  readonly maxMatchLength: number;
}

export interface IncompletePattern {
  readonly name: string;
  /** Anchored at end-of-buffer (no `m` flag); matches a dangerous tail. */
  readonly pattern: RegExp;
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
  return `${openQuote}${name}${closeQuote}${separator}${redactedValue}`;
}

const PRIVATE_KEY_LABEL = '[A-Z0-9 ]{0,64}';

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    name: 'private-key-block',
    pattern: new RegExp(
      `-----BEGIN ${PRIVATE_KEY_LABEL}PRIVATE KEY-----[\\s\\S]{0,8192}?-----END ${PRIVATE_KEY_LABEL}PRIVATE KEY-----`,
      'g',
    ),
    replacement: REDACTED_PLACEHOLDER,
    maxMatchLength: 8372,
  },
  {
    name: 'authorization-header',
    pattern: /\b((?:Proxy-)?Authorization[ \t]*:[ \t]*)[^\r\n]{0,2048}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 2069,
  },
  {
    name: 'cookie-header',
    pattern: /\b((?:Set-)?Cookie[ \t]*:[ \t]*)[^\r\n]{0,4096}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 4108,
  },
  {
    name: 'credential-url',
    pattern: /\b([a-z][a-z0-9+.-]{0,32}):\/\/[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi,
    replacement: `$1://${REDACTED_PLACEHOLDER}@`,
    maxMatchLength: 550,
  },
  {
    name: 'bearer-token',
    pattern: /\b(Bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,512}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 519,
  },
  {
    name: 'basic-token',
    pattern: /\b(Basic[ \t]+)[A-Za-z0-9+/=]{16,512}/gi,
    replacement: `$1${REDACTED_PLACEHOLDER}`,
    maxMatchLength: 518,
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
    // Independent optional quotes around the name (not a backreference): in
    // streaming, the opening quote may already have been emitted before the
    // field was recognized, so the held-back buffer can start at the name.
    pattern:
      /(["']?)([A-Za-z0-9_.-]{0,64}(?:token|secret|password|apiKey|authorization)[A-Za-z0-9_.-]{0,64})(["']?)([ \t]*[:=][ \t]*)("[^"]{0,4096}"|'[^']{0,4096}'|(?:Bearer|Basic)[ \t]+[^\s,;&]{1,512}|[^\s,;&]{1,512})/gi,
    replacement: redactSensitiveFieldValue as (...args: string[]) => string,
    maxMatchLength: 4234,
  },
];

export const INCOMPLETE_PATTERNS: readonly IncompletePattern[] = [
  {
    // Any trailing run of token characters: a token that ends exactly at the
    // buffer end may still grow with the next chunk. Multi-word markers
    // ("-----BEGIN RSA PRIV") are covered by the private-key-block pattern.
    name: 'trailing-token-fragment',
    pattern: /[A-Za-z0-9_.+/=$~-]{1,64}$/,
  },
  {
    name: 'private-key-block',
    pattern: new RegExp(
      `-----BEGIN ${PRIVATE_KEY_LABEL}PRIVATE KEY-----[\\s\\S]{0,8192}$|-----BEGIN[A-Z0-9 ]{0,80}$`,
    ),
  },
  {
    name: 'authorization-header',
    pattern: /\b(?:Proxy-)?Authorization[ \t]*:[ \t]*[^\r\n]{0,2048}$/i,
  },
  {
    name: 'cookie-header',
    pattern: /\b(?:Set-)?Cookie[ \t]*:[ \t]*[^\r\n]{0,4096}$/i,
  },
  {
    name: 'credential-url',
    pattern: /\b[a-z][a-z0-9+.-]{0,32}:\/\/[^/\s@]{0,513}$/i,
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer(?:[ \t]+[A-Za-z0-9._~+/=-]{0,512})?$/i,
  },
  {
    name: 'basic-token',
    pattern: /\bBasic(?:[ \t]+[A-Za-z0-9+/=]{0,512})?$/i,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{0,1024}(?:\.[A-Za-z0-9_-]{0,1024}){0,2}$/,
  },
  {
    name: 'sensitive-field',
    pattern:
      /["']?[A-Za-z0-9_.-]{0,64}(?:token|secret|password|apiKey|authorization)[A-Za-z0-9_.-]{0,64}["']?[ \t]*(?:[:=][ \t]*(?:"[^"]{0,4096}|'[^']{0,4096}|[^\s,;&]{0,512}(?:[ \t]+[^\s,;&]{0,512})?)?)?$/i,
  },
];

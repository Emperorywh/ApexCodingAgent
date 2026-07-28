/**
 * Redactor unit tests (SPEC §18.4): rule behavior, fixed placeholder,
 * type-preserving structured redaction and the streaming chunk redactor.
 * Exhaustive per-rule regression lives in the corpus test.
 */
import { describe, expect, it } from 'vitest';
import {
  REDACTED_PLACEHOLDER,
  type ChunkRedactor,
} from '../../../src/application/ports/redaction.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';

const redactor = createRedactor();

function stream(chunks: readonly string[]): string {
  const r: ChunkRedactor = redactor.createChunkRedactor();
  return chunks.map((chunk) => r.push(chunk)).join('') + r.flush();
}

describe('redactText', () => {
  it('redacts header values but keeps the header name', () => {
    expect(redactor.redactText('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      `Authorization: ${REDACTED_PLACEHOLDER}`,
    );
    expect(redactor.redactText('Proxy-Authorization: Bearer abcdefgh-12345678')).toBe(
      `Proxy-Authorization: ${REDACTED_PLACEHOLDER}`,
    );
    expect(redactor.redactText('Cookie: session=abc123def456')).toBe(
      `Cookie: ${REDACTED_PLACEHOLDER}`,
    );
    expect(redactor.redactText('Set-Cookie: sid=deadbeefcafe1234; HttpOnly')).toBe(
      `Set-Cookie: ${REDACTED_PLACEHOLDER}`,
    );
  });

  it('redacts bearer/basic tokens and keeps the scheme', () => {
    expect(redactor.redactText('Bearer abcdefgh-12345678')).toBe(`Bearer ${REDACTED_PLACEHOLDER}`);
    expect(redactor.redactText('basic QWxhZGRpbjpPcGVuU2VzYW1l')).toBe(
      `basic ${REDACTED_PLACEHOLDER}`,
    );
  });

  it('redacts credential URLs and keeps the scheme', () => {
    expect(redactor.redactText('https://user:Sup3rSecret@example.com/repo.git')).toBe(
      `https://${REDACTED_PLACEHOLDER}@example.com/repo.git`,
    );
  });

  it('redacts multi-line private key blocks', () => {
    const text = `log start\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----\nlog end`;
    expect(redactor.redactText(text)).toBe(`log start\n${REDACTED_PLACEHOLDER}\nlog end`);
  });

  it('redacts well-known API key shapes', () => {
    const cases = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijABCDEFGHIJ1234567890ab',
      'sk-abcdef1234567890ABCDEF_xyz',
      'xoxb-123456789012-abcdefghijkl',
      'AIzaSyD4iE2x6yVvB3nN8pQ9rT0uW1zX2yC3bA4',
      'rk_test_4eC39HqLyjWDarjtT1zdp7dc',
      'npm_abcdef1234567890ABCDEFGHIJ1234567890',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4',
    ];
    for (const token of cases) {
      const out = redactor.redactText(`prefix ${token} suffix`);
      expect(out, token).toBe(`prefix ${REDACTED_PLACEHOLDER} suffix`);
    }
  });

  it('redacts sensitive field values case-insensitively, preserving quote style', () => {
    expect(redactor.redactText('"apiKey": "secret-value-1"')).toBe(
      `"apiKey": "${REDACTED_PLACEHOLDER}"`,
    );
    expect(redactor.redactText("'CLIENT_SECRET': 'secret-value-2'")).toBe(
      `'CLIENT_SECRET': '${REDACTED_PLACEHOLDER}'`,
    );
    expect(redactor.redactText('DATABASE_PASSWORD=secret-value-3')).toBe(
      `DATABASE_PASSWORD=${REDACTED_PLACEHOLDER}`,
    );
    expect(redactor.redactText('accessToken: secret-value-4')).toBe(
      `accessToken: ${REDACTED_PLACEHOLDER}`,
    );
  });

  it('uses a fixed placeholder and never echoes, hashes or encodes the value', () => {
    const secret = 'correct-horse-battery-staple-7';
    const out = redactor.redactText(`password=${secret}`);
    expect(out).toBe(`password=${REDACTED_PLACEHOLDER}`);
    expect(out).not.toContain(secret);
    // no partial echo of the original value
    expect(out).not.toContain('correct-horse');
    expect(out).not.toContain('staple-7');
  });

  it('is idempotent', () => {
    const once = redactor.redactText('Authorization: Bearer abcdefgh-12345678');
    expect(redactor.redactText(once)).toBe(once);
  });
});

describe('redactStructured', () => {
  it('wholesale-redacts values of sensitive field names, case-insensitively', () => {
    const input = {
      apiKey: 'k1',
      Client_Secret: 'k2',
      PASSWORD: 'k3',
      accessToken: 'k4',
      authorization: 'k5',
      nested: { tokens: ['k6', 'k7'] },
      other: 'plain',
    };
    const out = redactor.redactStructured(input);
    expect(out.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(out.Client_Secret).toBe(REDACTED_PLACEHOLDER);
    expect(out.PASSWORD).toBe(REDACTED_PLACEHOLDER);
    expect(out.accessToken).toBe(REDACTED_PLACEHOLDER);
    expect(out.authorization).toBe(REDACTED_PLACEHOLDER);
    expect(out.nested.tokens).toEqual([REDACTED_PLACEHOLDER, REDACTED_PLACEHOLDER]);
    expect(out.other).toBe('plain');
  });

  it('scans non-sensitive strings for embedded secrets', () => {
    const out = redactor.redactStructured({
      message: 'call failed with Authorization: Bearer abcdefgh-12345678',
    });
    expect(out.message).toBe(`call failed with Authorization: ${REDACTED_PLACEHOLDER}`);
  });

  it('redacts sensitive primitive values while preserving their JSON types', () => {
    const input = {
      token: 42,
      secret: true,
      password: null,
      count: 7,
      list: [1, 'two', false],
      credentials: {
        nestedToken: 'deep-value',
        attempts: 9,
        enabled: true,
      },
    };
    const out = redactor.redactStructured(input);
    expect(out).toEqual({
      token: 0,
      secret: false,
      password: null,
      count: 7,
      list: [1, 'two', false],
      credentials: {
        nestedToken: REDACTED_PLACEHOLDER,
        attempts: 9,
        enabled: true,
      },
    });
  });

  it('propagates a sensitive parent field to every nested value', () => {
    /**
     * 敏感父对象下即使子字段名本身不敏感，也不能恢复为普通遍历模式；
     * 容器形状和 JSON 类型保留，但所有可携带秘密的叶子都被替换。
     */
    const out = redactor.redactStructured({
      authorization: {
        value: 'nested-secret',
        retryCount: 3,
        active: true,
        nullable: null,
        items: ['one', 7, false],
      },
    });
    expect(out.authorization).toEqual({
      value: REDACTED_PLACEHOLDER,
      retryCount: 0,
      active: false,
      nullable: null,
      items: [REDACTED_PLACEHOLDER, 0, false],
    });
  });

  it('does not mutate the input value', () => {
    const input = { credentials: { apiKey: 'k1' } };
    const out = redactor.redactStructured(input);
    expect(input.credentials.apiKey).toBe('k1');
    expect(out.credentials.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(out).not.toBe(input);
  });
});

describe('chunk redactor', () => {
  it('redacts a token split across chunk boundaries', () => {
    const out = stream(['see Bearer abc', 'defgh-12345678 done']);
    expect(out).toBe(`see Bearer ${REDACTED_PLACEHOLDER} done`);
  });

  it('redacts a private key block split mid-body', () => {
    const out = stream([
      'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB',
      'AAKCAQEA7\n-----END RSA PRIV',
      'ATE KEY-----\nb',
    ]);
    expect(out).toBe(`a\n${REDACTED_PLACEHOLDER}\nb`);
  });

  it('redacts a sensitive field split inside the quoted value', () => {
    const out = stream(['{"apiKey": "correct-horse-', 'battery-staple-7"}']);
    expect(out).toBe(`{"apiKey": "${REDACTED_PLACEHOLDER}"}`);
  });

  it('matches whole-text redaction for a mixed document', () => {
    const document = [
      'line one is fine',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'npm_abcdef1234567890ABCDEFGHIJ1234567890',
      '{"client_secret": "s3cr3t-v4lue"}',
      'done',
    ].join('\n');
    const whole = redactor.redactText(document);
    for (const size of [1, 2, 3, 5, 17, 64]) {
      const chunks: string[] = [];
      for (let index = 0; index < document.length; index += size) {
        chunks.push(document.slice(index, index + size));
      }
      expect(stream(chunks), `chunk size ${size}`).toBe(whole);
    }
  });

  it('emits plain text immediately and holds back only a short tail', () => {
    const r = redactor.createChunkRedactor();
    // Trailing space: no token run at the buffer end, everything is emitted.
    expect(r.push('hello world. ')).toBe('hello world. ');
    // "text" ends the buffer: held back as a potential fragment until flush.
    expect(r.push('more text')).toBe('more ');
    expect(r.flush()).toBe('text');
  });
});

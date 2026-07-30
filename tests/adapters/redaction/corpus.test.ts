/**
 * Credential corpus regression (SPEC §18.4, NFR-006): every corpus sample is
 * embedded into every sink shape — log lines, console lines, report markdown,
 * Session Record JSON and run.json — and written both as a whole block and
 * as randomly chunked streams. No output may contain the sample's secret;
 * redacted structured sinks must still pass their schema validation.
 *
 * The corpus is centralized and versioned at
 * `tests/fixtures/redaction-corpus/corpus.json`; every redaction rule must
 * have at least one sample (checked below).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REDACTED_PLACEHOLDER } from '../../../src/application/ports/redaction.js';
import {
  MAX_REDACTION_MATCH_LENGTH,
  REDACTION_RULES,
} from '../../../src/adapters/redaction/redaction-rules.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import { validate } from '../../../src/domain/schemas/index.js';
import { mkErrorRecord, mkResult, mkRun } from '../../domain/fixtures.js';
import { mkSessionRecord } from '../fixtures.js';

interface CorpusSample {
  readonly id: string;
  readonly rule: string;
  readonly snippet: string;
  readonly secret: string;
}

interface Corpus {
  readonly schemaVersion: number;
  readonly description: string;
  readonly samples: readonly CorpusSample[];
}

const corpusPath = fileURLToPath(
  new URL('../../fixtures/redaction-corpus/corpus.json', import.meta.url),
);
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as Corpus;

const redactor = createRedactor();

/** Deterministic PRNG so "random chunk boundaries" stay reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunkRandomly(text: string, seed: number): string[] {
  const random = mulberry32(seed);
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const size = 1 + Math.floor(random() * 96);
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  return chunks;
}

/**
 * 使用显式 chunk 序列执行一次完整的流式脱敏。
 *
 * 所有边界测试共用这一入口，避免测试辅助逻辑自身出现差异。
 */
function redactChunks(chunks: readonly string[]): string {
  const chunkRedactor = redactor.createChunkRedactor('all');
  let out = '';
  for (const chunk of chunks) {
    out += chunkRedactor.push(chunk);
  }
  return out + chunkRedactor.flush();
}

function redactStreamed(text: string, seed: number): string {
  return redactChunks(chunkRandomly(text, seed));
}

const TEXT_SINKS: ReadonlyArray<{ readonly name: string; readonly build: (snippet: string) => string }> = [
  {
    name: 'log line',
    build: (snippet) =>
      `[2026-01-02T03:04:05.006Z] [session 123e4567-e89b-42d3-a456-426614174000] claude stdout: ${snippet} — end of line`,
  },
  {
    name: 'console line',
    build: (snippet) => `apex: execution failed: ${snippet}`,
  },
  {
    name: 'report markdown',
    build: (snippet) =>
      `## Run summary\n\nThe failing output was: ${snippet}\n\nSee logs for details.\n`,
  },
];

function sessionRecordWith(snippet: string): unknown {
  return {
    ...mkSessionRecord(),
    structuredResult: mkResult({ summary: `Execution output: ${snippet}` }),
  };
}

function runJsonWith(snippet: string): unknown {
  return mkRun({
    lastError: mkErrorRecord({ message: `execution failed: ${snippet}`, toolSummary: snippet }),
  });
}

const STREAM_SEEDS = [1, 7, 42, 1337, 9001];

describe('redaction corpus', () => {
  it('is versioned and structurally sound', () => {
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.samples.length).toBeGreaterThan(0);
    const ruleByName = new Map(REDACTION_RULES.map((rule) => [rule.name, rule]));
    for (const sample of corpus.samples) {
      const rule = ruleByName.get(sample.rule);
      expect(rule, `sample ${sample.id} references unknown rule ${sample.rule}`).toBeDefined();
      expect(sample.snippet, `sample ${sample.id} snippet must contain its secret`).toContain(
        sample.secret,
      );
      expect(
        sample.secret.length,
        `sample ${sample.id} secret exceeds rule ${rule!.name} maxMatchLength`,
      ).toBeLessThanOrEqual(rule!.maxMatchLength);
    }
  });

  it('covers every redaction rule with at least one sample (NFR-006)', () => {
    const covered = new Set(corpus.samples.map((sample) => sample.rule));
    for (const rule of REDACTION_RULES) {
      expect(covered.has(rule.name), `rule ${rule.name} has no corpus sample`).toBe(true);
    }
  });

  it('matches whole-text redaction at every corpus chunk boundary', () => {
    /**
     * 对每条集中语料穷举所有二分边界以及 1～128 字符的固定分块。
     *
     * 这直接锁定“同一秘密因 chunk 切分位置不同而绕过脱敏”的缺陷；随机
     * 分块仍保留在各输出通道测试中，用于覆盖多个秘密与上下文组合。
     */
    for (const sample of corpus.samples) {
      const whole = redactor.redactText(sample.snippet);

      for (let split = 1; split < sample.snippet.length; split += 1) {
        const streamed = redactChunks([
          sample.snippet.slice(0, split),
          sample.snippet.slice(split),
        ]);
        expect(streamed, `${sample.id}: split ${split}`).toBe(whole);
        expect(streamed, `${sample.id}: split ${split}`).not.toContain(sample.secret);
      }

      const maxChunkSize = Math.min(128, sample.snippet.length);
      for (let chunkSize = 1; chunkSize <= maxChunkSize; chunkSize += 1) {
        const chunks: string[] = [];
        for (let index = 0; index < sample.snippet.length; index += chunkSize) {
          chunks.push(sample.snippet.slice(index, index + chunkSize));
        }
        const streamed = redactChunks(chunks);
        expect(streamed, `${sample.id}: chunk size ${chunkSize}`).toBe(whole);
        expect(streamed, `${sample.id}: chunk size ${chunkSize}`).not.toContain(sample.secret);
      }
    }
  });

  it('keeps every corpus secret intact while draining a long stream', () => {
    /**
     * 短语料会全部留到 flush，无法单独证明排出安全前缀时仍正确。
     *
     * 这里把每个秘密放在首次排水边界附近，并从秘密中间切开输入；若窗口
     * 长度、切点回退或规则长度契约有误，就会暴露原文片段或偏离整段结果。
     */
    const drainThreshold = MAX_REDACTION_MATCH_LENGTH * 2;
    for (const sample of corpus.samples) {
      const split = Math.max(1, Math.floor(sample.snippet.length / 2));
      const safePrefix = `${'x'.repeat(drainThreshold - split)}\n`;
      const text = `${safePrefix}${sample.snippet}`;
      const streamed = redactChunks([
        text.slice(0, safePrefix.length + split),
        text.slice(safePrefix.length + split),
      ]);

      expect(streamed, sample.id).toBe(redactor.redactText(text));
      expect(streamed, sample.id).not.toContain(sample.secret);
    }
  });

  describe('samples never leak into any sink', () => {
    for (const sample of corpus.samples) {
      describe(`sample ${sample.id} (${sample.rule})`, () => {
        it('is redacted directly from its snippet', () => {
          const out = redactor.redactText(sample.snippet);
          expect(out).not.toContain(sample.secret);
          expect(out).toContain(REDACTED_PLACEHOLDER);
        });

        for (const sink of TEXT_SINKS) {
          it(`is redacted in a ${sink.name}, whole and streamed`, () => {
            const text = sink.build(sample.snippet);
            const whole = redactor.redactText(text);
            expect(whole).not.toContain(sample.secret);
            expect(whole).toContain(REDACTED_PLACEHOLDER);
            for (const seed of STREAM_SEEDS) {
              const streamed = redactStreamed(text, seed);
              expect(streamed, `seed ${seed}`).not.toContain(sample.secret);
              expect(streamed, `seed ${seed}`).toBe(whole);
            }
          });
        }

        it('is redacted in a Session Record that stays schema-valid', () => {
          const redacted = redactor.redactStructured(sessionRecordWith(sample.snippet));
          const serialized = JSON.stringify(redacted);
          expect(serialized).not.toContain(sample.secret);
          expect(serialized).toContain(REDACTED_PLACEHOLDER);
          const result = validate('SessionRecord', redacted);
          expect(result.valid, JSON.stringify(result)).toBe(true);
        });

        it('is redacted in run.json that stays schema-valid', () => {
          const redacted = redactor.redactStructured(runJsonWith(sample.snippet));
          const serialized = JSON.stringify(redacted);
          expect(serialized).not.toContain(sample.secret);
          expect(serialized).toContain(REDACTED_PLACEHOLDER);
          const result = validate('RunJson', redacted);
          expect(result.valid, JSON.stringify(result)).toBe(true);
        });
      });
    }
  });
});

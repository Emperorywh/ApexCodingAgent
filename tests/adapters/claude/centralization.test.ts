/**
 * Claude 契约集中化守护：原始流事件解释和外部失败到 errorCode 的映射只能
 * 位于 `src/adapters/claude/`。扫描前移除注释，允许文档引用契约，同时
 * 对实际代码引用保持严格约束。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../../../src/', import.meta.url));
const CLAUDE_ADAPTER_PREFIX = 'adapters/claude/';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 移除块注释和行注释，供架构守护扫描实际代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

interface ScannedFile {
  readonly path: string;
  readonly code: string;
}

const FILES: ScannedFile[] = listSourceFiles(SRC_DIR).map((full) => ({
  path: relative(SRC_DIR, full).split('\\').join('/'),
  code: stripComments(readFileSync(full, 'utf8')),
}));

function offenders(matcher: (file: ScannedFile) => boolean): string[] {
  return FILES.filter(matcher).map((file) => file.path);
}

describe('claude contract centralization', () => {
  it('raw stream-event fields are interpreted only inside adapters/claude', () => {
    for (const literal of ['structured_output', 'session_id']) {
      const files = offenders(
        (file) => !file.path.startsWith(CLAUDE_ADAPTER_PREFIX) && file.code.includes(literal),
      );
      expect(files, `files referencing ${literal} outside adapters/claude`).toEqual([]);
    }
  });

  it('no source file references --resume or process ids', () => {
    const files = offenders(
      (file) => file.code.includes('--resume') || /process\.pid\b/.test(file.code),
    );
    expect(files).toEqual([]);
  });

  it('external claude failures are mapped to stable codes only inside adapters/claude', () => {
    /**
     * 适配器之外只允许错误码注册表、已验证结果的 Domain 语义门禁，以及
     * Session Record 不变量引用这些稳定错误码；这些模块都不得解析进程
     * 或原始流输出。
     */
    const allowed = new Set([
      'domain/errors.ts',
      'domain/results.ts',
      'domain/invariants.ts',
    ]);
    const claudeCodes = [
      'CLAUDE_START_FAILED',
      'CLAUDE_EXIT_NONZERO',
      'CLAUDE_STREAM_FAILED',
      'CLAUDE_RESULT_INVALID',
      'FINAL_REVIEW_RESULT_INVALID',
      'CLAUDE_CAPABILITY_MISSING',
      'CLAUDE_INSTALLATION_UNHEALTHY',
    ];
    for (const code of claudeCodes) {
      const files = offenders(
        (file) =>
          !file.path.startsWith(CLAUDE_ADAPTER_PREFIX) &&
          !allowed.has(file.path) &&
          file.code.includes(code),
      );
      expect(files, `files mapping ${code} outside adapters/claude`).toEqual([]);
    }
  });

  it('CLAUDE_REPORTED_FAILURE is mapped only at the Application decision point', () => {
    /**
     * decision == failed 不是外部失败，而是合法结构化结果；SPEC §9.6 与
     * TRACE §8 明确由 Application 用例映射 CLAUDE_REPORTED_FAILURE。除错误码
     * 注册表与该映射点外，任何模块（包括适配器）都不得引用此码。
     */
    const allowed = new Set(['domain/errors.ts', 'application/usecases/execute-next-task.ts']);
    const files = offenders(
      (file) => !allowed.has(file.path) && file.code.includes('CLAUDE_REPORTED_FAILURE'),
    );
    expect(files, 'files referencing CLAUDE_REPORTED_FAILURE outside the Application mapping point').toEqual([]);
  });
});

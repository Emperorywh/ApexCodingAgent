#!/usr/bin/env node
// Architecture guard (SPEC §5.3):
//   src/domain and src/application must not import node:* modules and must not
//   reference adapters / interfaces / bootstrap layers.
// Exits non-zero with a diagnostic per violating file.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scannedLayers = ['src/domain', 'src/application'];
const forbiddenLayerSegments = new Set(['adapters', 'interfaces', 'bootstrap']);

/** @param {string} dir @returns {string[]} */
function listTsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 通过 TypeScript AST 收集所有静态可判定的模块引用。
 *
 * 统一覆盖 import、export from、动态 import、import type、import equals 与
 * 静态 require，避免正则把注释或字符串内容误识别为真实的跨层依赖。
 *
 * @param {string} source
 * @param {string} file
 * @returns {string[]}
 */
function collectModuleSpecifiers(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];
  const collectLiteral = (node) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      collectLiteral(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'
        )
      )
    ) {
      collectLiteral(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      collectLiteral(node.argument.literal);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      collectLiteral(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** @param {string} specifier @returns {string | null} */
function classifyViolation(specifier) {
  if (specifier.startsWith('node:')) {
    return `forbidden node: import "${specifier}"`;
  }
  const segments = specifier.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    if (forbiddenLayerSegments.has(segment)) {
      return `forbidden reference to layer "${segment}" in "${specifier}"`;
    }
  }
  return null;
}

const violations = [];
for (const layer of scannedLayers) {
  for (const file of listTsFiles(join(repoRoot, layer))) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of collectModuleSpecifiers(source, file)) {
      const problem = classifyViolation(specifier);
      if (problem) {
        violations.push(`${relative(repoRoot, file)}: ${problem}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('check-architecture: FAILED');
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}

console.log(
  `check-architecture: OK (${scannedLayers.join(', ')} free of node:/adapters/interfaces/bootstrap references)`,
);

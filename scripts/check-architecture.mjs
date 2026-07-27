#!/usr/bin/env node
// Architecture guard (SPEC §5.3):
//   src/domain and src/application must not import node:* modules and must not
//   reference adapters / interfaces / bootstrap layers.
// Exits non-zero with a diagnostic per violating file.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const importSpecifierPattern =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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
    for (const match of source.matchAll(importSpecifierPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
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

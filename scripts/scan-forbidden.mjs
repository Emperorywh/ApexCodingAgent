#!/usr/bin/env node
/**
 * AC-025 / FR-019 / NFR-008 禁用项扫描（G6）。
 *
 * 1. 源码扫描：src/ 全部 .ts（剥离注释后）不得出现 Mutex、Named Pipe、
 *    Job Object、PID 追踪/恢复、Journal、Pause/Stop 类实现痕迹，也不得
 *    加载 .node 原生扩展（dlopen/napi/node-gyp 等）。Session Resume 自
 *    SPEC v4.2 起成为受支持特性（`resume` 命令经 Claude CLI 的
 *    `--resume --fork-session` 实现），不再属于禁用实现痕迹。
 * 2. 依赖扫描：按 package-lock.json 的真实安装路径遍历生产依赖闭包
 *    （含 optional/peer 边），不得包含 .node 原生模块或禁用包名；
 *    package.json 不得有 postinstall。
 *
 * 说明：tests/ 与 scripts/ 不在源码扫描范围内——测试与守护脚本会以
 * 否定形式引用这些概念（断言其不存在），并非产品实现。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 默认扫描脚本所在仓库；`--root` 只用于隔离 Fixture 和发布流水线。
 *
 * 显式根目录避免测试复制脚本或修改工作区，也让扫描行为能用负向样例验证。
 */
function resolveScanRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1) return fileURLToPath(new URL('..', import.meta.url));
  const root = argv[rootIndex + 1];
  if (root === undefined || root === '') {
    throw new Error('scan-forbidden: --root requires a directory path');
  }
  return resolve(root);
}

const repoRoot = resolveScanRoot(process.argv.slice(2));

/** 禁用实现痕迹（作用于剥离注释后的源码，大小写不敏感）。 */
const FORBIDDEN_SOURCE_PATTERNS = [
  [/\bmutex\b/i, 'Mutex'],
  [/\bnamed[-_ ]?pipe\b/i, 'Named Pipe'],
  [/\\\\\.\\pipe\\/i, 'Windows Named Pipe path'],
  [/\bjob[-_ ]?object\b/i, 'Job Object'],
  [/\bjournal/i, 'Journal'],
  [/\bpaus(e|ed|ing)\b/i, 'Pause 状态/协议'],
  [/\bstop(?:ped|ping)?\b/i, 'Stop 状态/协议'],
  [/\bcancel(?:led|ling|ed|ing)?\b/i, 'Cancel 状态/协议'],
  [/\bwaiting[_-]?for\b/i, 'waiting_* 状态'],
  [/\bpid\b/i, 'PID 追踪/恢复'],
  [/\bdlopen\b/i, '原生扩展加载'],
  [/\bnapi\b/i, 'N-API'],
  [/node[-_]?gyp/i, 'node-gyp'],
  [/node[-_]?addon[-_]?api/i, 'node-addon-api'],
  [/\.node['"`\s]/i, '.node 原生模块引用'],
];

/** 生产依赖包名禁用模式（原生扩展与 C#/.NET/Rust/C++ 运行时，NFR-008）。 */
const FORBIDDEN_PACKAGE_PATTERNS = [
  /mutex/i,
  /named[-_]?pipe/i,
  /job[-_]?object/i,
  /journal/i,
  /\bnapi\b/i,
  /node[-_]?gyp/i,
  /node[-_]?addon[-_]?api/i,
  /^bindings$/i,
  /^prebuild/i,
  /dotnet|\.net/i,
  /^rust/i,
];

/**
 * 递归列出目标后缀文件，可按目录名截断独立依赖边界。
 *
 * 依赖扫描跳过包内 node_modules，因为精确 lockfile 闭包会单独扫描每个
 * 嵌套包；这样避免重复诊断和错误归属，同时仍扫描包自身的 vendor 目录。
 */
function listFiles(dir, suffixes, excludedDirectories = new Set()) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!excludedDirectories.has(entry)) {
        out.push(...listFiles(full, suffixes, excludedDirectories));
      }
    } else if (suffixes.some((suffix) => entry.endsWith(suffix))) out.push(full);
  }
  return out;
}

/** 剥离块注释与行注释（保留字符串中的 "://"）。 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/g, '$1');
}

const violations = [];

/**
 * 扫描产品源码中的禁用实现痕迹。
 *
 * 只扫描 TypeScript 产品源文件；测试和守护脚本会以否定语义引用这些词，
 * 不属于可发布运行时代码。
 */
function scanSource(root) {
  const sourceRoot = join(root, 'src');
  if (!existsSync(sourceRoot)) {
    violations.push('src/: 源码目录缺失');
    return;
  }
  for (const file of listFiles(sourceRoot, ['.ts'])) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, label] of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.test(stripped)) {
        violations.push(`${relative(root, file)}: 命中禁用实现痕迹 ${label} (${pattern})`);
      }
    }
  }
}

/**
 * 合并一个包的运行时依赖边。
 *
 * dependencies 为必需边；optionalDependencies 与可选 peer 为可选边。
 * 同名依赖同时出现时，必需语义优先，禁止可选声明掩盖真实运行时依赖。
 */
function dependencyEdges(entry) {
  const edges = new Map();
  for (const name of Object.keys(entry?.dependencies ?? {})) {
    edges.set(name, true);
  }
  for (const name of Object.keys(entry?.optionalDependencies ?? {})) {
    if (!edges.has(name)) edges.set(name, false);
  }
  for (const name of Object.keys(entry?.peerDependencies ?? {})) {
    const optional = entry?.peerDependenciesMeta?.[name]?.optional === true;
    if (!edges.has(name) || !optional) edges.set(name, !optional);
  }
  return [...edges].map(([name, required]) => ({ name, required }));
}

/**
 * 按 Node 的逐级 node_modules 查找规则解析 lockfile 中的精确包路径。
 *
 * 不能仅使用 node_modules/<name>：同一依赖可能以不同版本嵌套安装，
 * 包名去重会检查错目录并漏掉真实生产闭包。
 */
function resolveDependencyKey(packages, parentKey, dependencyName) {
  let base = parentKey;
  for (;;) {
    const candidate = `${base === '' ? '' : `${base}/`}node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (base === '') return null;
    const ancestorMarker = base.lastIndexOf('/node_modules/');
    base = ancestorMarker === -1 ? '' : base.slice(0, ancestorMarker);
  }
}

/**
 * 收集精确的生产依赖闭包，并传播“是否必需安装”的事实。
 *
 * link 包使用其 resolved 元数据继续遍历，但保留 node_modules 中的安装
 * 路径用于文件扫描；可选包未在当前平台安装时不伪报 npm ci 缺失。
 */
function collectProductionPackages(lock) {
  const packages = lock.packages;
  if (packages === null || typeof packages !== 'object' || packages[''] === undefined) {
    violations.push('package-lock.json: 缺少 lockfile v2/v3 packages 根记录');
    return [];
  }

  const requiredByKey = new Map();
  const nameByKey = new Map();
  const queue = [];
  const enqueueEdges = (parentKey, parentRequired, entry) => {
    for (const edge of dependencyEdges(entry)) {
      const key = resolveDependencyKey(packages, parentKey, edge.name);
      if (key === null) {
        if (parentRequired && edge.required) {
          violations.push(
            `package-lock.json: 必需依赖 ${edge.name} 无法从 ${parentKey || '<root>'} 解析`,
          );
        }
        continue;
      }
      queue.push({
        key,
        name: edge.name,
        required: parentRequired && edge.required,
      });
    }
  };

  enqueueEdges('', true, packages['']);
  while (queue.length > 0) {
    const current = queue.shift();
    const knownRequired = requiredByKey.get(current.key);
    if (knownRequired === true || (knownRequired === false && !current.required)) continue;
    requiredByKey.set(current.key, current.required);
    nameByKey.set(current.key, current.name);

    const installedEntry = packages[current.key] ?? {};
    const resolvedKey =
      installedEntry.link === true && typeof installedEntry.resolved === 'string'
        ? installedEntry.resolved.replace(/\\/g, '/').replace(/^\.\//, '')
        : current.key;
    const metadataEntry = packages[resolvedKey] ?? installedEntry;
    enqueueEdges(current.key, current.required, metadataEntry);
  }

  return [...requiredByKey].map(([key, required]) => ({
    key,
    required,
    name: nameByKey.get(key),
  }));
}

/**
 * 扫描生产依赖包名与实际安装目录。
 *
 * 必需依赖缺失表示环境没有完成 npm ci；可选依赖仅在当前平台实际安装时
 * 检查文件，但其 lockfile 包名始终参与禁用模式判断。
 */
function scanDependencies(root) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (packageJson.scripts && 'postinstall' in packageJson.scripts) {
    violations.push('package.json: 禁止 postinstall（发布骨架约束）');
  }

  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const productionPackages = collectProductionPackages(lock);
  for (const dependency of productionPackages) {
    for (const pattern of FORBIDDEN_PACKAGE_PATTERNS) {
      if (pattern.test(dependency.name)) {
        violations.push(`依赖 ${dependency.name}: 命中禁用包名模式 (${pattern})`);
      }
    }

    const directory = join(root, dependency.key);
    if (!existsSync(directory)) {
      if (dependency.required) {
        violations.push(`依赖 ${dependency.name}: ${dependency.key} 中缺失（请先 npm ci）`);
      }
      continue;
    }
    for (const file of listFiles(directory, ['.node'], new Set(['node_modules']))) {
      violations.push(
        `依赖 ${dependency.name}: 包含 .node 原生模块 ${relative(root, file)}`,
      );
    }
  }
  return productionPackages.length;
}

scanSource(repoRoot);
const productionPackageCount = scanDependencies(repoRoot);

if (violations.length > 0) {
  console.error('scan-forbidden: FAILED (AC-025)');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log(
  `scan-forbidden: OK (src 无禁用实现痕迹；生产依赖闭包 ${productionPackageCount} 个包无原生模块)`,
);

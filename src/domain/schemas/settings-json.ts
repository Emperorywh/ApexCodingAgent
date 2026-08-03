/**
 * settings.json (SPEC §16). Optional user configuration; strict schema with
 * explicit `null` for unset paths. Unknown fields and wrong types must fail.
 */
export type ExecutionPermissionMode = 'auto' | 'bypassPermissions';

export const EXECUTION_PERMISSION_MODES: readonly ExecutionPermissionMode[] = [
  'auto',
  'bypassPermissions',
];

/*
 * 远程名进入 Git 参数数组前只接受可推导的安全字符集合。
 * 这同时排除选项注入、空名称和依赖 Git 隐式解析的特殊名称。
 */
export const GIT_REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SettingsJson {
  schemaVersion: 1;
  executionPermissionMode: ExecutionPermissionMode;
  claudeCliPath: string | null;
  gitCliPath: string | null;
  pushRemote: string;
}

/**
 * 配置 Schema 保持标准 JSON Schema 的显式 null 联合。
 *
 * CLI 路径不把缺字段视为 null，完整字段映射由集中契约测试覆盖。
 */
export const settingsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'executionPermissionMode',
    'claudeCliPath',
    'gitCliPath',
    'pushRemote',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    executionPermissionMode: { type: 'string', enum: [...EXECUTION_PERMISSION_MODES] },
    claudeCliPath: { type: ['string', 'null'], minLength: 1 },
    gitCliPath: { type: ['string', 'null'], minLength: 1 },
    pushRemote: { type: 'string', pattern: GIT_REMOTE_NAME_PATTERN.source },
  },
} as const;

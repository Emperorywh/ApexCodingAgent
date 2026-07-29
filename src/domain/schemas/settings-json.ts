/**
 * settings.json (SPEC §16). Optional user configuration; strict schema with
 * explicit `null` for unset paths. Unknown fields and wrong types must fail.
 */
export type ExecutionPermissionMode = 'auto' | 'bypassPermissions';

export const EXECUTION_PERMISSION_MODES: readonly ExecutionPermissionMode[] = [
  'auto',
  'bypassPermissions',
];

export interface SettingsJson {
  schemaVersion: 1;
  executionPermissionMode: ExecutionPermissionMode;
  claudeCliPath: string | null;
  gitCliPath: string | null;
}

/**
 * 配置 Schema 保持标准 JSON Schema 的显式 null 联合。
 *
 * CLI 路径不把缺字段视为 null，完整字段映射由集中契约测试覆盖。
 */
export const settingsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'executionPermissionMode', 'claudeCliPath', 'gitCliPath'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    executionPermissionMode: { type: 'string', enum: [...EXECUTION_PERMISSION_MODES] },
    claudeCliPath: { type: ['string', 'null'], minLength: 1 },
    gitCliPath: { type: ['string', 'null'], minLength: 1 },
  },
} as const;

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

export const settingsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'executionPermissionMode', 'claudeCliPath', 'gitCliPath'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    executionPermissionMode: { enum: [...EXECUTION_PERMISSION_MODES] },
    claudeCliPath: { type: ['string', 'null'], minLength: 1 },
    gitCliPath: { type: ['string', 'null'], minLength: 1 },
  },
} as const;

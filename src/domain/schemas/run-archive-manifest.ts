/**
 * Run Archive Manifest (SPEC §11.6). Self-contained description of one
 * archived terminal Run under `history/<run-id>/`.
 */
import { RUN_ID_PATTERN, SHA256_PATTERN } from '../ids.js';

export type ArchivedRunStatus = 'completed' | 'failed' | 'abandoned';

export interface RunArchiveManifestFile {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface RunArchiveManifest {
  schemaVersion: 1;
  runId: string;
  runStatus: ArchivedRunStatus;
  archivedAt: string;
  files: RunArchiveManifestFile[];
}

export const runArchiveManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'runId', 'runStatus', 'archivedAt', 'files'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    runId: { type: 'string', pattern: RUN_ID_PATTERN.source },
    runStatus: { enum: ['completed', 'failed', 'abandoned'] },
    archivedAt: { type: 'string', format: 'rfc3339' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'byteLength', 'sha256'],
        properties: {
          path: { type: 'string', minLength: 1 },
          byteLength: { type: 'integer', minimum: 0 },
          sha256: { type: 'string', pattern: SHA256_PATTERN.source },
        },
      },
    },
  },
} as const;

/**
 * Central ajv instance with the custom string formats required by SPEC §11.5:
 * `uuid` (canonical lowercase), `sha256` (64 lowercase hex), `git-oid`
 * (full lowercase OID) and `rfc3339` (UTC RFC 3339).
 */
import { Ajv } from 'ajv';
import { isGitOid, isSha256, isUuid } from '../ids.js';
import { isRfc3339Utc } from '../time.js';

export const CUSTOM_FORMATS = ['uuid', 'sha256', 'git-oid', 'rfc3339'] as const;

export function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat('uuid', { type: 'string', validate: isUuid });
  ajv.addFormat('sha256', { type: 'string', validate: isSha256 });
  ajv.addFormat('git-oid', { type: 'string', validate: isGitOid });
  ajv.addFormat('rfc3339', { type: 'string', validate: isRfc3339Utc });
  return ajv;
}

/**
 * SPEC §11.5 要求的集中式 AJV 自定义格式。
 *
 * 包含规范小写 UUID、SHA-256、完整 Git OID、Git 相对路径，以及
 * 使用 UTC Z 标识的 RFC 3339 时间。
 */
import { Ajv } from 'ajv';
import { isGitOid, isSha256, isUuid } from '../ids.js';
import { isGitRelativePath } from '../paths.js';
import { isRfc3339Utc } from '../time.js';

/**
 * 集中注册全部跨 Schema 共享格式。
 *
 * `git-relative-path` 将项目路径的持久化约束收敛到 Domain，Adapter
 * 在真正访问文件时仍会进行第二次包含关系校验。
 */
export const CUSTOM_FORMATS = [
  'uuid',
  'sha256',
  'git-oid',
  'git-relative-path',
  'rfc3339',
] as const;

export function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat('uuid', { type: 'string', validate: isUuid });
  ajv.addFormat('sha256', { type: 'string', validate: isSha256 });
  ajv.addFormat('git-oid', { type: 'string', validate: isGitOid });
  ajv.addFormat('git-relative-path', { type: 'string', validate: isGitRelativePath });
  ajv.addFormat('rfc3339', { type: 'string', validate: isRfc3339Utc });
  return ajv;
}

/**
 * settings.json 加载（SPEC §16）。可选用户配置：不存在返回 null；存在则
 * 读原始字节 → UTF-8 解码 → JSON.parse → 内置 SettingsJson Schema 校验。
 * 解析或校验失败抛 SETTINGS_INVALID（stage 'settings'），未知字段和类型
 * 错误必须明确失败（§16、§11.5）。
 */
import { ApexError } from '../../domain/errors.js';
import { validate } from '../../domain/schemas/index.js';
import type { SettingsJson } from '../../domain/schemas/settings-json.js';
import type { FileSystemPort } from '../ports/file-system.js';

/*
 * 自动推送的内置远程目标集中定义在配置边界。
 * StartRun 只负责按 CLI、settings.json、内置默认的顺序解析一次并快照。
 */
export const DEFAULT_PUSH_REMOTE = 'origin';

function settingsInvalid(message: string, cause?: unknown): ApexError {
  return new ApexError({ code: 'SETTINGS_INVALID', stage: 'settings', message, cause });
}

/** 读取 `${stateDir}/settings.json`；文件不存在时返回 null。 */
export async function loadSettings(
  fileSystem: FileSystemPort,
  stateDir: string,
): Promise<SettingsJson | null> {
  const path = `${stateDir}/settings.json`;
  if ((await fileSystem.stat(path)) === null) return null;

  const bytes = await fileSystem.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw settingsInvalid(`settings.json 不是合法的 UTF-8 JSON: ${detail}`, error);
  }

  const result = validate('SettingsJson', parsed);
  if (!result.valid) {
    const detail = result.issues
      .map((issue) => `${issue.path} (${issue.keyword}): ${issue.message}`)
      .join('; ');
    throw settingsInvalid(`settings.json Schema 校验失败: ${detail}`);
  }
  return parsed as SettingsJson;
}

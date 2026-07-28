/**
 * State-directory exclude management (SPEC §3.1, §8.2 step 1).
 *
 * The exclude file is located with `git rev-parse --git-path info/exclude`,
 * which resolves correctly for plain repositories, `.git`-file worktrees and
 * linked worktrees alike — the code never assumes `.git` is a directory and
 * never touches the project's `.gitignore`. Adding `.apex-coding-agent/` is
 * idempotent: an existing exact line is left alone.
 *
 * Failures map to `GIT_COMMAND_FAILED`; the start use case surfaces them as
 * startup-stage diagnostics (SPEC §8.2: step 1 failure creates no Run).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gitCommandFailed, type GitRunner } from './cli.js';

const STATE_DIR_EXCLUDE_LINE = '.apex-coding-agent/';

export async function ensureStateDirectoryExcluded(git: GitRunner, root: string): Promise<void> {
  const { stdout } = await git.run(['rev-parse', '--git-path', 'info/exclude'], root);
  const excludePath = resolve(root, stdout.trim());

  let content: string;
  try {
    content = await readFile(excludePath, 'utf8');
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== 'ENOENT') {
      throw gitCommandFailed(`failed to read git exclude file ${excludePath}`, { cause: error });
    }
    content = '';
  }

  const alreadyExcluded = content.split(/\r?\n/).some((line) => line === STATE_DIR_EXCLUDE_LINE);
  if (alreadyExcluded) return;

  try {
    await mkdir(dirname(excludePath), { recursive: true });
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    await writeFile(excludePath, `${separator}${STATE_DIR_EXCLUDE_LINE}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
  } catch (error) {
    throw gitCommandFailed(`failed to update git exclude file ${excludePath}`, { cause: error });
  }
}

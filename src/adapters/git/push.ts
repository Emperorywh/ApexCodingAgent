/**
 * Run 分支远程发布适配器。
 *
 * 本模块只负责远程目标校验与 fast-forward 推送；本地 Checkpoint 的选择、
 * 提交和业务状态转换仍分别属于 checkpoint 模块与 Application 用例。
 */
import { ApexError } from '../../domain/errors.js';
import { GIT_REMOTE_NAME_PATTERN } from '../../domain/schemas/settings-json.js';
import type { PublishRunBranchInput } from '../../application/ports/GitPort.js';
import type { GitRunner } from './cli.js';
import { assertHeadOnRunBranch } from './invariants.js';

/** 把不可信的 Git stderr 限制在稳定、已脱敏的诊断边界内。 */
function pushFailed(git: GitRunner, message: string, stderr?: string, cause?: unknown): ApexError {
  const summary = git.redact(stderr?.trim() ?? '');
  return new ApexError({
    code: 'GIT_PUSH_FAILED',
    stage: 'git-push',
    message: git.redact(message),
    ...(summary.length === 0 ? {} : { toolSummary: summary.slice(0, 2_000) }),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * 启动前只读确认远程配置。
 *
 * 只读取带 URL 的配置键名，不读取 URL 值；远程 URL 可能内嵌凭据，
 * 即使仅做存在性检查也不得让其进入 Coordinator 内存或诊断文本。
 */
export async function assertPushRemote(
  git: GitRunner,
  root: string,
  remote: string,
): Promise<void> {
  if (!GIT_REMOTE_NAME_PATTERN.test(remote)) {
    throw new ApexError({
      code: 'GIT_REMOTE_INVALID',
      stage: 'startup',
      message: `push remote name is invalid: ${remote}`,
    });
  }
  const configured = await git.runAllowFailure(
    ['config', '--name-only', '--get-regexp', '^remote\\..*\\.url$'],
    root,
  );
  const remoteKey = `remote.${remote}.url`;
  const configuredKeys = configured.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (configured.code !== 0 || !configuredKeys.includes(remoteKey)) {
    throw new ApexError({
      code: 'GIT_REMOTE_INVALID',
      stage: 'startup',
      message: `push remote is not configured: ${remote}`,
      ...(configured.stderr.trim().length === 0
        ? {}
        : { toolSummary: git.redact(configured.stderr.trim()).slice(0, 2_000) }),
    });
  }
}

/**
 * 把已验证的本地 Run 分支发布到同名远程分支。
 *
 * refspec 两端都使用完整 refs/heads 路径，不依赖当前 upstream、
 * push.default 或用户全局 Git 配置；非 fast-forward 更新由 Git 拒绝。
 */
export async function publishRunBranch(
  git: GitRunner,
  root: string,
  input: PublishRunBranchInput,
): Promise<void> {
  /*
   * 本地事实验证与远程错误分开：分支/OID 漂移是仓库并发冲突，只有真正
   * 执行传输失败才映射为 GIT_PUSH_FAILED。
   */
  await assertHeadOnRunBranch(git, root, input.runBranch);
  const head = (await git.run(['rev-parse', '--verify', 'HEAD'], root)).stdout.trim();
  if (head !== input.checkpointOid) {
    throw new ApexError({
      code: 'GIT_FACT_CONFLICT',
      stage: 'git-push',
      message: `Checkpoint ${input.checkpointOid} is not current HEAD ${head}`,
    });
  }
  const branchRef = `refs/heads/${input.runBranch}`;
  try {
    await git.run(
      ['push', '--set-upstream', input.remote, `${branchRef}:${branchRef}`],
      root,
    );
  } catch (error) {
    if (error instanceof ApexError) {
      throw pushFailed(
        git,
        `failed to push Run Branch to remote ${input.remote}`,
        error.toolSummary ?? undefined,
        error,
      );
    }
    throw pushFailed(
      git,
      `failed to push Run Branch to remote ${input.remote}`,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

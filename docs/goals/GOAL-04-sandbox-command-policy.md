# GOAL-04：沙箱与命令策略

## 目标

实现 Windows 基线上的 SandboxPort、CommandPolicyPort 和隔离工作区，使 Reviewer 写操作、未授权命令、未批准网络与凭据环境在模型或命令启动前被技术边界拒绝。

对应 SPEC §5.1～§5.3、§10.4～§10.5、§12.3、§18、AC-006 和 §22 第 4 步。

## 前置条件

- GOAL-03 已完成。
- GOAL-00 的强隔离、认证网络、进程树和批准 ADR 已通过技术验证。

## 必读

- SPEC §2.3、§5、§10.4～§10.5、§12.3、§18。
- 沙箱、Reviewer 认证、进程树和批准 ADR。
- command catalog、workspaceProvision、路径规范和 ErrorRecord。
- `scripts/scan-forbidden.mjs` 及其测试。

## 范围

### 1. SandboxPort

端口必须表达而非隐藏：

- workspace 创建来源和 reviewedHead。
- `execution_write`、`review_readonly`、`verification_write_ephemeral` 等能力配置。
- 文件系统隔离等级。
- 网络策略。
- 环境允许列表。
- 子进程树生命周期。
- timeout。
- 弱隔离批准事实。
- 清理和退出确认结果。

Adapter 负责 Windows 机制；Application 只消费结构化事实。

### 2. 文件系统边界

实现：

- `git worktree` 隔离。
- `.git`、Agent 状态目录和仓库外路径保护。
- Reviewer 启动前只读技术边界。
- Verification 只能写隔离工作区临时输出。
- 阶段结束后工作区清单校验。
- reparse point、junction、symlink 和大小写路径绕过防护。
- 清理失败的可恢复 ErrorRecord。

不得把“阶段结束后发现写入”当作 Reviewer 只读的充分实现。

### 3. 网络与环境

落实 ADR 和 SPEC 降级矩阵：

- Verification 默认 deny。
- 强隔离使用用户批准的防火墙出站阻断。
- 弱隔离只能由用户逐 Run 显式批准。
- 未获批准且需要网络的命令拒绝。
- 最小环境允许列表。
- 不继承 Token、Cookie、SSH、云凭据或其他秘密。
- Reviewer 只获得调用模型所需、ADR 明确允许的认证/网络能力。
- `--full-access` 只影响 Execution Claude 权限，不改变本边界。

### 4. 进程树

- 所有工具经统一进程执行边界启动。
- 使用 argv 数组和 `shell: false`。
- Windows 隐藏窗口。
- timeout 后终止整棵子进程树。
- 必须确认全部退出。
- 无法保证时返回 `SANDBOX_UNAVAILABLE`，不直接执行。

### 5. CommandPolicyPort

输入必须是结构化命令事实，输出必须区分：

- allow。
- require_user_approval。
- deny。

策略必须检查：

- 命令来自已接受 Plan catalog 或受控 tool ID。
- 真实 executable 解析结果。
- 固定参数约束。
- cwd 位于隔离工作区。
- timeout、网络和输出预算。
- 远程推送、部署、付款、生产数据操作。
- 未知 executable 与动态 Shell。

建立版本化系统受控工具目录，不允许模型提供任意绝对 executable 路径。

### 6. 审计事实

记录：

- 隔离级别和批准者。
- policy hash。
- resolved executable。
- argv、cwd、网络、timeout。
- 安全拒绝和只读违规。
- workspace 创建/销毁结果。

外部文本必须脱敏。

## 明确不在范围

- 不实现 Verification 业务循环。
- 不定义 EvidenceRecord 的完整 data。
- 不实现浏览器截图或 OCR。
- 不实现 Reviewer 判定。
- 不用 Prompt 约束替代技术边界。

## 测试

必须包含真实 Windows 边界集成测试：

- Reviewer 对受保护文件的写入在启动前能力边界上失败。
- Reviewer 不能写仓库外测试目录。
- Verification 写入只存在于临时工作区。
- 未授权 executable、Shell、push、网络和凭据读取被拒绝。
- 环境子进程看不到测试秘密。
- 弱隔离无逐 Run 批准时拒绝。
- timeout 后孙进程也退出。
- worktree/ACL/firewall 设置在成功、失败和中断后正确清理。
- junction/symlink/reparse point 不能逃逸。
- 沙箱不可用不退化为直接执行。

测试不得修改用户真实防火墙或广泛 ACL；必须使用隔离测试资源和显式清理协议。

## 完成定义

- SandboxPort 和 CommandPolicyPort 只暴露最小能力。
- Reviewer 只读是可重复验证的技术事实。
- Verification 网络和环境遵循强/弱降级矩阵。
- 任一安全边界不可用时安全失败。
- 生产依赖无原生扩展、postinstall 或禁用运行时。
- 安全集成测试、`npm test`、架构守护和禁用项扫描全绿。
- 需求账本、ADR 实施状态和 `STATUS.md` 已更新。

## 交接给 GOAL-05

必须交接：

- Sandbox Session 输入/输出契约。
- Command Policy 审计事实。
- workspace 生命周期和 reviewedHead 绑定。
- Artifact 临时输出允许路径。
- 输出和环境预算接口。


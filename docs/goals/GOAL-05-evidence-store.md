# GOAL-05：类型化 Evidence Store

## 目标

建立不可变、可哈希、可预算、可脱敏并与 reviewedHead 绑定的 Evidence Store，彻底替换自然语言 acceptanceEvidence 和模型自证。

对应 SPEC §5.4、§6.2 Evidence Policy、§10.1～§10.3、§10.6、§15、AC-004、AC-005 的存储基础，以及 §22 第 5 步的前半部分。

## 前置条件

- GOAL-04 已完成。
- `state.json`、immutable store、Sandbox 审计事实和 Evidence Policy 已稳定。

## 必读

- SPEC §3.3、§5.1、§5.4、§6.2、§10.1～§10.3、§10.6、§15、§18。
- Evidence 相关需求账本。
- State Store immutable 协议。
- RedactionPort 契约和现有脱敏语料测试。

## 范围

### 1. EvidenceRecord 判别联合

实现以下 kind：

- `command`
- `repository_fact`
- `image`
- `measurement`
- `ocr`
- `manual_attestation`
- `document`

公共字段至少包含：

- evidenceId、runId、operationId。
- taskId 和 criterionIds。
- reviewedHead。
- producer 权威字段。
- 已脱敏 summary。
- kind 对应的严格 data。
- Artifact 引用。
- capturedAt。

模型不得提供 evidenceId、producer、时间、哈希或 reviewedHead 等系统权威字段。

### 2. 类型化 data

按 SPEC §10.2 实现严格判别联合：

- command：executable、argv、cwd、exit、起止时间、timeout、网络、脱敏输出、截断。
- repository_fact：OID、normalized path、文件哈希、查询方法和结果。
- image：SHA-256、像素、生成条件、视口、DPR、数据条件和 Head。
- measurement：数值、单位、阈值、比较规则、方法、样本和环境。
- ocr：输入图哈希、目标/识别文本、置信度、阈值和规则。
- manual_attestation：verdict、观察、条件和 Head。
- document：路径、哈希、criterion 和提取方法。

不得使用无约束 `data` 或按 kind 强制转换。

### 3. Artifact 存储

实现：

- 安全复制到 `evidence/artifacts/`。
- SHA-256、媒体类型、字节数和相对路径。
- 单文件和总量预算。
- 临时文件到不可变目标的原子协议。
- reparse point、路径逃逸和替换竞态防护。
- 无法安全脱敏或验证的 Artifact 拒绝保存，并记录稳定原因。

### 4. Record 存储和状态索引

顺序必须为：

1. 校验输入和预算。
2. 写入并校验 Artifact。
3. 写入并校验 Evidence Record。
4. 计算 Record 哈希。
5. 通过 `state.json.evidenceIndex` 原子引用。

未被状态引用的 Record/Artifact 为 orphan，不参与任何 Review。

### 5. Evidence Policy 求值

实现纯领域求值：

- 只接受当前 reviewedHead 的 Evidence。
- 只接受引用当前 criterion 的 Evidence。
- 执行 `allOf/anyOf/kind`。
- 强制 criterion kind 映射。
- visual criterion 必须是 image 加规定的第二类 Evidence。
- 不因 Evidence 数量增加而自动满足。
- 人工、历史、参考项目或 Execution 自述不能冒充当前系统 Evidence。

### 6. 预算与脱敏

- 记录每项输出、Artifact 和 Run 总 Evidence 字节。
- 超限返回 `EVIDENCE_BUDGET_EXCEEDED`。
- 不静默截掉关键结构；命令输出允许有界并记录截断事实。
- 所有外部 summary、命令输出、文档提取和拒绝原因经过 RedactionPort。
- 新脱敏规则同步语料回归样本。

## 明确不在范围

- 不执行 Verification 命令。
- 不启动浏览器、开发服务器或 OCR。
- 不导入人工 attestation。
- 不调用 Reviewer。
- 不把 proposedEvidence 自动视为 Evidence。

## 测试

必须覆盖：

- 每个 kind 的有效和无效 Schema。
- kind 与 data 不匹配。
- criterion kind 与 Evidence kind 映射。
- 嵌套 Evidence Policy。
- reviewedHead、criterion 和 run/task 不匹配。
- Record/Artifact 不可覆盖。
- Artifact 哈希、媒体类型、大小和路径逃逸。
- 各写入崩溃窗口及 orphan 行为。
- 单项、Artifact 和 Run 总预算。
- 跨 chunk 脱敏和不可安全保存 Artifact。
- Evidence 数量或自然语言自述不能满足 Policy。

## 完成定义

- 生产领域中不再存在可决定完成的自由文本 acceptanceEvidence。
- 所有 Evidence 都能定位到 operation、criterion 和 reviewedHead。
- Evidence Store 无可变 manifest 或第二份事实。
- 不安全或超预算内容安全失败。
- Evidence Policy 由代码确定性执行。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-06

交接必须列明：

- EvidenceRecord 创建 API。
- Artifact 临时输入和不可变输出协议。
- command/image/measurement/ocr/manual data 构造器。
- Evidence 预算查询和剩余额度。
- Policy 求值 API。


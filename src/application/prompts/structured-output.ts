/**
 * Claude Code 的 `--json-schema` 会在 Agent 工作流结束时提供专用的
 * StructuredOutput 工具。所有会话共用同一提交协议，避免各类 Prompt
 * 分别描述后产生歧义，也避免模型把最终 JSON 误写成普通文本。
 */
export const STRUCTURED_OUTPUT_INSTRUCTION = `STRUCTURED_OUTPUT_SUBMISSION_PROTOCOL（结构化结果提交协议）：
1. 系统已通过 --json-schema 提供最终结果 Schema；完成工作后必须调用 StructuredOutput 工具提交与该 Schema 匹配的完整对象。
2. 如果 StructuredOutput 尚未出现在可用工具中，先调用 ToolSearch，query 使用 "select:StructuredOutput"，然后立即调用 StructuredOutput。
3. 不得把最终 JSON 作为普通文本、Markdown 或代码块输出，也不得用普通文本模拟或重复 StructuredOutput 调用。
4. 只有 StructuredOutput 工具成功接受结果才表示本 Session 完成；在调用成功前不得自行结束。`;

/**
 * 把统一协议放在完整 Prompt 的最末尾，使首次会话、断点续接和结果修复
 * 都以相同方式结束。调用方仍只负责自身业务上下文与结果字段语义。
 */
export function withStructuredOutputInstruction(prompt: string): string {
  return `${prompt}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}`;
}

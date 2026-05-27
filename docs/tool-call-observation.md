# Tool Call And Observation Design

当前 harness 的 tool call 协议是 PTY-first：模型通过 `bash` 发 PTY action，harness 校验 owner/revision 后写入真实 PTY 或执行 PTY control。观察结果统一为 `PtyObservation` 或可恢复的 `AgentObservation`。

## Design Principles

1. 模型可见的外部动作面只有 `bash`。
2. `bash` arguments 必须是 PTY action，不存在命令级双轨。
3. PTY 是字节和按键流，不是 shell line API；Enter 是 `\n` 或 `key: "enter"`。
4. 长文本、生成文件和 IM 回复都通过纯 PTY 动作完成：文本/代码使用 `write_text`，短答复使用 PTY 内的 `im send` CLI；不存在额外暂存工具或 model-visible frame action。
5. Tool review 仍位于执行前；demo 模式可以默认 approve。
6. Observation 返回 owner、action summary、terminal events、log ref 和错误码；完整输出留在 session log。

## FIM Decision Tool Call Protocol

Decision pass 由 harness 预填：

```text
<｜Assistant｜><think>
{thinking_from_pass_1}
</think>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="
```

请求不传 `suffix`。模型输出遇到 `</｜DSML｜invoke>` 停止，harness 本地追加：

```text
</｜DSML｜invoke>
</｜DSML｜tool_calls><｜end▁of▁sentence｜>
```

允许的 function name：

- `bash`
- `io_wait`

## Bash PTY Actions

Example shell command submission:

```json
{
  "kind": "write_text",
  "session": "default",
  "expectedOwnerRevision": 7,
  "text": "npm test\n"
}
```

Example key input:

```json
{
  "kind": "key",
  "session": "default",
  "expectedOwnerRevision": 8,
  "key": "ctrl-c"
}
```

Example heredoc write:

```json
{
  "kind": "write_text",
  "session": "default",
  "expectedOwnerRevision": 10,
  "text": "cat > app.html <<'EOF'\\n<!doctype html>\\n<title>App</title>\\nEOF\\n"
}
```

## Observation Shape

```ts
type PtyObservation = {
  session: string;
  owner: TerminalOwner;
  action: PtyActionSummary;
  result: "ok" | "rejected" | "timeout" | "interrupted";
  events: TerminalEventSummary[];
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
};
```

Rejected input is recoverable. The model should inspect the current owner and choose `poll`, `status`, `interrupt`, `terminate`, `restart`, or a corrected owner/revision-guarded action.

## Current Execution Path

```text
ModelTurn(tool_call bash)
  -> ToolCallValidator
  -> ToolReviewer
  -> RunOrchestrator
  -> TerminalPort
  -> ManagedTerminalRuntime
  -> ManagedPtySession
  -> PtyObservation
```

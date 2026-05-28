# Tool Call And Observation Design

当前 harness 的 tool call 协议是 PTY-first，并为大文件恢复了受限 staging：模型通过 `bash` 发 PTY action，harness 校验 inputSeq 后写入真实 PTY 或执行 PTY control；模型也可以通过 `stash_file` 把完整文件 bytes 暂存在 harness state，再通过 PTY 内 `file materialize` CLI 显式落盘。观察结果统一为 `PtyObservation` 或 `AgentObservation`。

## Design Principles

1. 模型可见的外部动作面只有 `bash` 和 `stash_file`。
2. `bash` arguments 必须是 PTY action，不存在命令级双轨。
3. PTY 是字节和按键流，不是 shell line API；Enter 是 `\n` 或 `key: "enter"`。
4. 小片段可以通过 PTY/heredoc 完成；大文本、生成文件和脆弱内容使用 `stash_file` 暂存，再用 PTY 内 `file materialize` CLI 写入目标路径；不存在 frame action 或 receiver 协议。
5. Tool review 仍位于执行前；demo 模式可以默认 approve。
6. Observation 返回 terminal facts、action summary、terminal events、log ref 和错误码；完整输出留在 session log。

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
  "expectedInputSeq": 7,
  "text": "npm test\n"
}
```

Example key input:

```json
{
  "kind": "key",
  "session": "default",
  "expectedInputSeq": 8,
  "key": "ctrl-c"
}
```

Example foreground stdin write for generated files:

```json
{
  "kind": "write_text",
  "session": "default",
  "expectedInputSeq": 10,
  "text": "cat > app.html\\n"
}
```

Then poll until the PTY is waiting for input, write the payload directly, close stdin with Ctrl-D, and poll until the prompt returns. For large generated files, prefer `stash_file` and then materialize through bash. Oversized heredoc payloads are recoverably rejected and should be retried with `stash_file`.

Example staged file write:

```json
{
  "name": "app.html",
  "content": "<!doctype html>\n<title>App</title>\n",
  "encoding": "utf8"
}
```

The returned observation includes a `stashId`. The next bash action should run:

```bash
node dist/cli/main.js file materialize <stashId> app.html
```

## Observation Shape

```ts
type PtyObservation = {
  session: string;
  terminal: TerminalState;
  action: PtyActionSummary;
  result: "ok" | "rejected" | "timeout" | "interrupted";
  eventCount: number;
  eventsOmitted?: number;
  events: TerminalEventSummary[];
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
};
```

`PtyObservation` is a bounded summary for the next model prompt, not the full PTY log. `events` and `outputPreview` are capped; full output stays in the session log, and the summary uses `eventCount`, `eventsOmitted`, and `logRef` to show when more output exists. Serialized assistant tool-call history uses the same principle for large prior `write_text.text` and `stash_file.content` payloads: it preserves the field shape but omits oversized text from the next prompt, while the raw executed tool call remains in transcript/state.

After `write_text` or `key` input, the managed runtime waits briefly before reading the PTY and building this observation. The delay is intentionally small: it captures immediate terminal echo and fast command output without turning every action into a long wait. Longer-running commands still require `poll` or `io_wait`.

New managed PTY sessions drain the shell initialization prompt before the first model-visible observation when it arrives within the startup window. Prompt parsing also tolerates terminal-control residue such as Ctrl-D echo/backspace before a trusted prompt marker, so returning from foreground stdin consumers is not mistaken for ordinary output.

For user-visible IM replies, a `write_text` observation without a shell prompt is not proof that the reply was sent. The agent must poll until the prompt returns and should use `im send --text-stdin` with a quoted heredoc for replies so Markdown is sent as literal stdin and shell argument quoting is avoided.

Rejected input is recoverable. The model should inspect the terminal facts and PTY output, then choose `poll`, `status`, `interrupt`, `terminate`, `restart`, or a corrected inputSeq-guarded action.

## Current Execution Path

```text
ModelTurn(tool_call bash|stash_file)
  -> ToolCallValidator
  -> ToolReviewer
  -> RunOrchestrator
  -> TerminalPort | StashFileStore
  -> PtyObservation | AgentObservation
```

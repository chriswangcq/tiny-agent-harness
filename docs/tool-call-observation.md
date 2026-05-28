# Tool Call And Observation Design

当前 harness 的 tool call 协议是 PTY-first：模型通过 `bash` 发 PTY action，harness 校验 inputSeq 后写入真实 PTY 或执行 PTY control；所有 `write_text` 输入由 runtime 保护性 pacing。模型也可以通过 `stash_file` 把完整 bytes 暂存在 harness state，再通过 PTY 内 `file materialize` CLI 显式落盘，或通过 `file cat` CLI 将 bytes 输出到 stdin consumer。观察结果统一为 `PtyObservation` 或 `AgentObservation`。

## Design Principles

1. 模型可见的外部动作面只有 `bash` 和 `stash_file`。
2. `bash` arguments 必须是 PTY action，不存在命令级双轨。
3. PTY 是字节和按键流，不是 shell line API；Enter 是 `\n` 或 `key: "enter"`。
4. 文本 payload 可以通过 PTY/heredoc 完成；runtime 会对所有 `write_text` 输入做保护性 pacing。`stash_file` 仅作为显式 staged bytes 的可选通道；不存在 frame action 或 receiver 协议。
5. Tool review 仍位于执行前；demo 模式可以默认 approve。
6. Observation 返回 terminal facts、action summary、`outputTail`、terminal events、log ref 和错误码；完整输出留在 session log。

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

Example generated text file write:

```json
{
  "kind": "write_text",
  "session": "default",
  "expectedInputSeq": 10,
  "text": "cat > app.html <<'HTML'\\n<!doctype html>\\n<title>App</title>\\nHTML\\n"
}
```

Generated text files should use normal shell syntax, usually a quoted heredoc. The runtime protects every `write_text` with pacing, so the model should not manually chunk ordinary text. Poll until the prompt or a clear command result returns before sending the next command. `stash_file` is only the optional staged-bytes path.

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

For one-shot stdin consumers, the next bash action can instead stream bytes:

```bash
node dist/cli/main.js file cat <stashId> | bash
node dist/cli/main.js im send --channel default --kind status --text-stdin < <(node dist/cli/main.js file cat <stashId>)
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
  outputTail?: string;
  outputTailBytes?: number;
  newOutputBytes?: number;
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
};
```

`PtyObservation` is a bounded terminal glance for the next model prompt, not the full PTY log. `outputTail` is the primary model-facing PTY view: after `write_text` or `key`, the managed runtime waits briefly, then returns the current session's last 2K characters; `poll` and `status` return the same current-session tail without writing input. `outputPreview` is kept as a compatibility alias for the same tail. `events` are structured tail events for state/debug, not the primary success signal. Full output stays in the session log; `eventCount`, `eventsOmitted`, `newOutputBytes`, and `logRef` show when more output exists. Serialized assistant tool-call history is different: historical assistant tool-call arguments are replayed exactly as generated, including large `write_text.text` and `stash_file.content` fields.

After `write_text` or `key` input, the managed runtime waits about 100ms before reading the PTY and building this observation. The delay is intentionally small: it captures immediate terminal echo and fast command output without turning every action into a long wait. Longer-running commands still require `poll` or `io_wait`.

New managed PTY sessions drain the shell initialization prompt before the first model-visible observation when it arrives within the startup window. Prompt parsing also tolerates terminal-control residue such as Ctrl-D echo/backspace before a trusted prompt marker, so prompt return is not mistaken for ordinary output.

For user-visible IM replies, a `write_text` observation without a shell prompt is not proof that the reply was sent. The agent must poll until the prompt returns and should use `im send --text-stdin`. A quoted heredoc is valid for normal text replies; input redirection and `file cat` process substitution are also valid when they make the command simpler.

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

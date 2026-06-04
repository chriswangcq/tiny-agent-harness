# Tool Call And Observation Design

当前目标协议仍然是 PTY-first，但模型不再看到一个混杂的 `bash` action union。可见动作拆成 terminal input tools 和 session management tools。所有 PTY observation 统一成「人类看一眼终端当前屏幕」的 bounded glance。

## Design Principles

1. 模型可见工具见 [Model Visible Tool Catalog](model-visible-tool-catalog.md)。
2. PTY 是字节和按键流，不是 shell line API；Enter 是 `\n` 或 `terminal_key({ key: "enter" })`。
3. `terminal_write` / `terminal_key` 没有 `session` 参数，只能写 current session。
4. `session_focus` 是改变 current session 的唯一常规入口。
5. `session_observe` 返回 current 或指定 session 的一屏 semantic terminal viewport，不改变 current session。
6. Observation 不是日志分页 API。完整输出写入 session log；需要更多历史时，agent 使用 bash 原生命令读取日志。
7. Tool review 仍位于执行前；demo 模式可以默认 approve。
8. `io_wait` 是 run state decision，不是 shell 命令，也不是 PTY control。

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

- `terminal_write`
- `terminal_key`
- `session_observe`
- `session_list`
- `session_focus`
- `session_interrupt`
- `session_restart`
- `session_terminate`
- `io_wait`

## Current Session Rule

`currentSession` 是 TerminalRuntime 的显式状态，不是每次 tool call 的隐式猜测。

```text
session_focus("server")
  -> currentSession = "server"
  -> returns screen for server

terminal_write("npm test\n")
  -> writes to currentSession only
  -> no session argument exists

session_observe("default")
  -> observes default
  -> currentSession remains server
```

这条规则避免 agent 看着 `default` 的 observation，却把输入发到 `server`。凡是会影响前台交互的输入，都必须先 focus，再拿到该 session 的最新 `inputSeq`。

## Example Tool Calls

Submit a shell command to current session:

```json
{
  "expectedInputSeq": 7,
  "text": "npm test\n"
}
```

Send Enter to current session:

```json
{
  "expectedInputSeq": 8,
  "key": "enter"
}
```

Observe another session without changing focus:

```json
{
  "session": "server"
}
```

Focus or create a session:

```json
{
  "session": "test",
  "create": true,
  "cwd": "/repo"
}
```

Generated text files should use normal shell syntax, usually a quoted heredoc through `terminal_write`:

```json
{
  "expectedInputSeq": 10,
  "text": "cat > app.html <<'HTML'\n<!doctype html>\n<title>App</title>\nHTML\n"
}
```

There is no file-staging side channel in this target design. Ordinary generated files, IM replies, reports, and scripts are all created through shell-native flows.

## Observation Shape

All PTY-observing tools return `TerminalObservation`.

```ts
type TerminalObservation = {
  currentSession: string;
  observedSession: string;
  result: "ok" | "rejected" | "timeout" | "interrupted";
  terminal: TerminalFacts;
  returnedToPrompt: boolean;
  screen: PtyScreen;
  message?: string;
  errorCode?: TerminalErrorCode;
};

type PtyScreen = {
  text: string;
  rows: number;
  cols: number;
  truncated: boolean;
  logRef?: {
    path: string;
  };
};
```

The referenced `TerminalFacts` is the durable terminal fact surface:

```ts
type TerminalFacts = {
  inputSeq: number;
  alive: boolean;
  syncStatus: "trusted" | "unsynced";
  lastShellPrompt: ShellPromptSnapshot | null;
  lastContinuationPrompt: ContinuationPromptSnapshot | null;
  termination: TerminalTermination | null;
  foregroundProcess: string | null;
};
```

`screen.text` is a semantic terminal viewport snapshot, not a log tail. It should fit at most one configured terminal screen, such as `rows=30`, `cols=120`. Managed shell markers and continuation prompt chrome are stripped from this model-facing viewport; the main prompt remains visible to preserve cwd/user orientation. Raw PTY bytes remain auditable through `screen.logRef.path`. In the CLI runtime this path is a run-scoped file such as `.tiny-agent/runs/<runId>/sessions/<safe-session-id>-<sha256-10>.log`; unconfigured tests may use a virtual fallback. The implementation may keep an internal scrollback buffer, but the model-facing observation should not expose arbitrary offsets, `sinceOutputOffset`, `newOutputBytes`, or page-sized history.

`returnedToPrompt` is the compact success signal for normal command sequencing: it means the latest observation saw a shell or continuation prompt. The agent should still inspect `screen.text` and `terminal.lastShellPrompt` when deciding the next input.

`screen.truncated` means the screen is not the full output history. The agent should read `screen.logRef.path` with bash-native commands when it needs more context:

```bash
tail -n 200 <screen.logRef.path>
rg "error|failed" <screen.logRef.path>
sed -n '120,180p' <screen.logRef.path>
```

If inspecting a log would disturb a live foreground process, the agent should `session_focus` a scratch/default shell first, then run the log-inspection command there.

## Terminated Sessions

`session_terminate` kills the PTY process and records `terminal.alive=false` plus `terminal.termination`. The session remains inspectable: `session_observe` returns the retained semantic screen/log path and `session_list` includes the dead session snapshot.

Dead sessions do not accept foreground input. `terminal_write`, `terminal_key`, and `session_interrupt` reject with `TERMINAL_TERMINATED` before bytes reach the PTY adapter. Recovery is explicit: use `session_restart` for the same session id, or `session_focus` a different live session.

## Return Timing

`terminal_write`, `terminal_key`, and `session_interrupt` return after an immediate one-screen glance by default. They can still wait up to an explicit `waitForReturnMs` for a shell or continuation prompt as a low-level escape hatch, but normal orchestration should use `io_wait` for environment events.

- Default wait budget is `0`.
- To wait for command completion or other meaningful terminal lifecycle events, use `io_wait` with no `minLevel` or with `minLevel: 10`.
- To wait for every event, including low-value session output, use explicit `minLevel: 0`. User messages are level `100`, so they can always wake normal waits.

Timeout means:

```text
the action was sent,
no prompt returned before the wait budget,
the foreground process is still allowed to run,
the agent should use session_observe, session_interrupt, session_restart, or io_wait next.
```

Timeout never kills the PTY process. It only releases the agent loop from focusing on that action.

## Tool Policy Review

All terminal/session requests pass through the `ToolReviewer` boundary before execution. Demo runs can still use `AlwaysApproveReviewer`, but the product path has a pure `ToolPolicyReviewer` adapter around `evaluateToolPolicy(request, options)`.

The policy evaluator does not execute shell commands or read process state. It classifies the explicit `ToolRequest` payload and returns transcript/display-ready findings:

- rejected dangerous terminal writes: broad recursive delete, raw disk writes, filesystem formatting, broad permission changes, pipe-to-shell installers, privileged destructive commands, force push, fork bombs, likely secret file reads, and system directory writes;
- warning terminal writes: network transfer, global package install, recursive permission changes, ownership changes, and ordinary git push;
- safe cases: constrained terminal keys, session/read tools, and simple terminal writes.

`allowDangerousTerminalWrites` is an explicit policy option. When enabled, dangerous findings become warnings so audits still show why the request was risky.

## Input Sequence

Write-like and foreground-impacting actions require `expectedInputSeq`.

```text
terminal_write
terminal_key
session_interrupt
```

If `expectedInputSeq` is stale, the action is rejected before writing to the PTY. The rejection should include a fresh one-screen observation with the latest `terminal.inputSeq` whenever possible.

`session_observe`, `session_list`, `session_focus`, `session_restart`, and `session_terminate` do not need `expectedInputSeq` because they either do not send foreground bytes or intentionally reset/terminate a PTY.

## Current Execution Path

```text
ModelTurn(tool_call terminal_* | session_* | io_wait)
  -> ToolCallValidator
  -> ToolReviewer
  -> RunOrchestrator
  -> TerminalPort | Environment.waitFor
  -> TerminalObservation | AgentObservation
```

`io_wait` observations remain synthetic `AgentObservation` entries. PTY screen observations remain bounded and human-aligned.

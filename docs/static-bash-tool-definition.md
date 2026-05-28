# Static Bash Tool Definition

本文记录当前 model-visible tool catalog。Harness 不再暴露命令级 bash request 或 session control request；模型看到的外部动作是 `bash` 和 `stash_file`，等待外部事件用内部 decision function `io_wait`。

## Decision

```text
StaticToolCatalog
  contains two model-visible external tools: bash, stash_file

DeepSeekFimAdapter
  receives ToolDefinition[]
  appends io_wait as the internal wait function
  normalizes DSML decisions into ModelTurn

ToolCallValidator
  accepts only PTY action payloads for bash
  accepts stash_file payloads for staged file bytes
  rejects command-shaped bash payloads

RunOrchestrator
  validates -> reviews -> executes PTY actions through TerminalPort
  executes stash_file through StashFileStore

ManagedTerminalRuntime
  owns persistent node-pty sessions
  applies terminal inputSeq validation
  writes exact PTY bytes or terminal key sequences
```

## Bash Input Schema

`bash` input is a discriminated PTY action object:

```ts
type BashToolInput =
  | { kind: "write_text"; session?: string; expectedInputSeq: number; text: string }
  | { kind: "key"; session?: string; expectedInputSeq: number; key: TerminalKey }
  | { kind: "poll"; session?: string; sinceSeq?: number }
  | { kind: "status"; session?: string }
  | { kind: "interrupt"; session?: string; expectedInputSeq?: number }
  | { kind: "terminate"; session?: string }
  | { kind: "restart"; session?: string; cwd?: string };
```

Important semantics:

- `write_text` writes exact text bytes. It does not append Enter. Include `\n` explicitly or use `{ kind: "key", key: "enter" }`.
- All `write_text` input is protected-paced by the runtime at about 128 bytes per chunk with a small delay so interactive bash can keep up. The model should not manually split, throttle, or sleep to protect PTY input.
- After `write_text` or `key` input, the runtime waits briefly before reading PTY output so immediate echo or command output can land in the same observation.
- New managed PTY sessions drain shell initialization output before the first model-visible observation when startup reaches the prompt quickly.
- The runtime reports terminal facts such as `alive`, `inputSeq`, `syncStatus`, `lastShellPrompt`, and `lastContinuationPrompt`. It does not infer whether shell, Python, ssh, cat, vim, or another foreground program should receive the next bytes.
- `key` is for terminal keys such as Enter, Ctrl-C, Ctrl-D, Escape, Tab, Up, and Down.
- `poll`, `status`, `interrupt`, `terminate`, and `restart` are control actions over the PTY session, not shell commands.
- Every write-like action carries `expectedInputSeq`; stale input sequences are rejected.
- Use normal shell syntax for textual payloads. Quoted shell heredocs are the default for generated files, code, HTML, Markdown, JSON, and multiline messages. Choose a delimiter that does not appear alone in the payload. Avoid PTY text for binary data or giant single-line/minified payloads; use line-broken text when possible. `stash_file` is only for explicit staged bytes and is not required for ordinary textual heredocs.
- After any multiline command or stdin flow, poll until the shell prompt or a clear command result returns before sending the next command. A `lastContinuationPrompt` fact means the shell recently reported a continuation prompt.
- Observations are bounded PTY glances: full PTY output stays in the session log, and `outputTail` carries the current session's last 2K characters after write_text/key or poll/status.
- Serialized assistant tool-call history replays historical tool-call arguments exactly as generated, including large `write_text.text` and `stash_file.content` fields. PTY observations remain bounded summaries; use `outputTail` first, terminal facts second, and `eventCount`, `eventsOmitted`, `newOutputBytes`, and `logRef` only for debugging or fetching more terminal history.

## Stash File Schema

`stash_file` stages bytes in harness state and does not write the workspace:

```ts
type StashFileInput = {
  name?: string;
  content: string;
  encoding?: "utf8" | "base64";
  description?: string;
};
```

The observation returns a short `stashId`, `bytes`, a materialize command, and a cat command. The actual filesystem write is explicit and PTY-visible:

```bash
node dist/cli/main.js file materialize <stashId> <target-path>
```

To stream the stashed bytes to a stdin consumer without a temporary target file:

```bash
node dist/cli/main.js file cat <stashId>
```

When `name` is provided, the returned command may use that filename directly so the next bash action is short. Integrity hashes stay in stash metadata and explicit JSON/debug output; they are not part of the model-facing observation or the normal materialize message.

## Large Payloads

Agent-authored IM replies should use `--text-stdin` so shell argument quoting, terminal wrapping, backticks, pipes, and `$` do not rewrite or clutter the message. A quoted heredoc is valid for normal text replies:

```bash
node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'
Done.
IM
```

Input redirection is also valid when it makes the command simpler:

```bash
node dist/cli/main.js im send --channel default --kind status --text-stdin < reply.md
```

If the reply is already stashed and does not need a durable file, stream it directly:

```bash
node dist/cli/main.js im send --channel default --kind status --text-stdin < <(node dist/cli/main.js file cat <stashId>)
```

After sending an IM reply, poll until the shell prompt returns and the command output indicates success before choosing `io_wait`.

Generated text files and code should use normal shell syntax. Quoted heredocs are the standard form for ordinary textual files, while input redirection or `file cat` process substitution are available when an already existing or stashed file should feed stdin.

All `write_text` input is protected-paced internally by the runtime, so the model does not need to invent a second payload protocol or manually split ordinary textual input. After any multiline command, poll until the prompt or a clear command result returns.

There is no frame action, receiver protocol, or binary payload side channel. Binary or opaque transfer should use `stash_file` with `encoding: "base64"` when needed.

## Non Goals

- No command-shaped bash tool payload.
- No separate text control action.
- No line-oriented PTY action.
- No provider-native tool calling dependency.

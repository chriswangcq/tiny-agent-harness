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
  rejects command-shaped bash payloads and oversized heredocs

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
- Large `write_text` payloads are accepted by the tool and internally paced into PTY writes so the model does not need to chunk ordinary shell input. This solves PTY transport, not shell parsing.
- After `write_text` or `key` input, the runtime waits briefly before reading PTY output so immediate echo or command output can land in the same observation.
- New managed PTY sessions drain shell initialization output before the first model-visible observation when startup reaches the prompt quickly.
- The runtime reports terminal facts such as `alive`, `inputSeq`, `syncStatus`, `lastShellPrompt`, and `lastContinuationPrompt`. It does not infer whether shell, Python, ssh, cat, vim, or another foreground program should receive the next bytes.
- `key` is for terminal keys such as Enter, Ctrl-C, Ctrl-D, Escape, Tab, Up, and Down.
- `poll`, `status`, `interrupt`, `terminate`, and `restart` are control actions over the PTY session, not shell commands.
- Every write-like action carries `expectedInputSeq`; stale input sequences are rejected.
- Quoted shell heredocs are acceptable for small fixed snippets below about 4KB. Generated files, code, HTML, Markdown, JSON, or multiline replies above that size should use `stash_file`, followed by `node dist/cli/main.js file materialize <stashId> <target-path>` through bash.
- After any multiline stdin flow, keep polling until the shell prompt returns. A `lastContinuationPrompt` fact means the shell recently reported a continuation prompt.
- Observations are bounded summaries: full PTY output stays in the session log and observations carry previews, `eventCount`, `eventsOmitted`, and `logRef`.
- Serialized assistant tool-call history replays historical tool-call arguments exactly as generated, including large `write_text.text` and `stash_file.content` fields. PTY observations remain bounded summaries; use `eventCount`, `eventsOmitted`, `outputPreview`, and `logRef` to understand when more terminal output exists.

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

The observation returns a short `stashId`, `bytes`, and a materialize command. The actual filesystem write is explicit and PTY-visible:

```bash
node dist/cli/main.js file materialize <stashId> <target-path>
```

When `name` is provided, the returned command may use that filename directly so the next bash action is short. Integrity hashes stay in stash metadata and explicit JSON/debug output; they are not part of the model-facing observation or the normal materialize message.

## Large Payloads

Agent-authored IM replies should use `--text-stdin` so shell argument quoting, terminal wrapping, backticks, pipes, and `$` do not rewrite or clutter the message. For replies, prefer a quoted heredoc because it is concise and stable for Markdown:

```bash
node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'
Done.

```text
Markdown is preserved literally.
```
IM
```

After sending an IM reply, poll until the shell prompt returns and the command output indicates success before choosing `io_wait`.

Generated text files and code can use small quoted heredocs when below the heredoc guard limit. Larger or fragile payloads should use `stash_file`. Interactive foreground stdin programs can still use direct PTY stdin so the payload does not go through shell parsing:

1. Use `write_text` to run `cat > path\n` or another intentionally chosen stdin consumer.
2. Poll until it is clearly waiting for input.
3. Use `write_text` to send the file text directly to that foreground process. End text payloads with `\n`.
4. Send `{ kind: "key", key: "ctrl-d" }` to close stdin, then poll until the shell prompt returns. End text payloads with `\n` before Ctrl-D. If the text did not end with `\n`, one Ctrl-D may only flush the current line while the foreground program keeps reading; do not send any further shell command until a prompt returns, and send a second Ctrl-D if needed.

Large `write_text` payloads are accepted by the tool and paced internally by the runtime, so the model does not need to invent a second payload protocol or manually split ordinary shell input.

There is no frame action, receiver protocol, or binary payload side channel. Binary or opaque transfer should use `stash_file` with `encoding: "base64"` when needed.

## Non Goals

- No command-shaped bash tool payload.
- No separate text control action.
- No line-oriented PTY action.
- No provider-native tool calling dependency.

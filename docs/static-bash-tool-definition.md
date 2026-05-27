# Static Bash Tool Definition

本文记录当前 model-visible tool catalog。Harness 不再暴露命令级 bash request、session control request 或额外文件暂存工具；模型看到的外部动作只有 `bash`，等待外部事件用内部 decision function `io_wait`。

## Decision

```text
StaticToolCatalog
  contains exactly one model-visible external tool: bash

DeepSeekFimAdapter
  receives ToolDefinition[]
  appends io_wait as the internal wait function
  normalizes DSML decisions into ModelTurn

ToolCallValidator
  accepts only PTY action payloads for bash
  rejects non-PTY payloads

RunOrchestrator
  validates -> reviews -> executes PTY actions through TerminalPort

ManagedTerminalRuntime
  owns persistent node-pty sessions
  applies TerminalOwner/revision validation
  writes exact PTY bytes or terminal key sequences
```

## Bash Input Schema

`bash` input is a discriminated PTY action object:

```ts
type BashToolInput =
  | { kind: "write_text"; session?: string; expectedOwnerRevision: number; text: string }
  | { kind: "key"; session?: string; expectedOwnerRevision: number; key: TerminalKey }
  | { kind: "poll"; session?: string; sinceSeq?: number }
  | { kind: "status"; session?: string }
  | { kind: "interrupt"; session?: string; expectedOwnerRevision?: number }
  | { kind: "terminate"; session?: string }
  | { kind: "restart"; session?: string; cwd?: string };
```

Important semantics:

- `write_text` writes exact text bytes. It does not append Enter. Include `\n` explicitly or use `{ kind: "key", key: "enter" }`.
- Large `write_text` payloads are accepted by the tool and internally paced into PTY writes so the model does not need to chunk ordinary shell input.
- When `owner.kind` is `process`, `write_text` is accepted for `stdinMode: "interactive"` and `stdinMode: "unknown"`; only `stdinMode: "none"` rejects text. Treat `unknown` as a foreground process that may accept stdin, not as proof that arbitrary text is safe.
- `key` is for terminal keys such as Enter, Ctrl-C, Ctrl-D, Escape, Tab, Up, and Down.
- `poll`, `status`, `interrupt`, `terminate`, and `restart` are control actions over the PTY session, not shell commands.
- Every write-like action carries `expectedOwnerRevision`; stale revisions are rejected.
- After sending a heredoc or multi-line script, keep polling until the shell prompt returns. A `shell_continuation` owner means the shell is still waiting for input.

## Large Payloads

Short IM replies should be sent with the IM CLI through the PTY, for example:

```bash
node dist/cli/main.js im send --channel default --kind status --text "Done"
```

Generated text files and code can use shell heredocs or small scripts through `write_text` when the content is small and simple. For large generated text/code, prefer a foreground stdin consumer so the payload does not go through shell parsing:

1. Use `write_text` to run `cat > path\n` or another intentionally chosen stdin consumer.
2. Poll until the owner becomes `process`.
3. Use `write_text` to send the file text directly to that foreground process. End text payloads with `\n`.
4. Send `{ kind: "key", key: "ctrl-d" }` to close stdin, then poll until the shell prompt returns. If the text did not end with `\n`, Ctrl-D may need to be sent twice.

Large `write_text` payloads are accepted by the tool and paced internally by the runtime, so the model does not need to invent a second payload protocol or manually split ordinary shell input.

There is no model-visible file staging protocol, frame action, or binary payload channel. Binary or opaque transfer should be redesigned as a separate explicit feature if it becomes necessary later.

## Non Goals

- No command-shaped bash tool payload.
- No separate text control action.
- No line-oriented PTY action.
- No model-visible file staging tool.
- No provider-native tool calling dependency.

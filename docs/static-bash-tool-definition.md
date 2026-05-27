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
- `key` is for terminal keys such as Enter, Ctrl-C, Ctrl-D, Escape, Tab, Up, and Down.
- `poll`, `status`, `interrupt`, `terminate`, and `restart` are control actions over the PTY session, not shell commands.
- Every write-like action carries `expectedOwnerRevision`; stale revisions are rejected.

## Large Payloads

Generated files, IM replies, code blocks, and other multi-KB payloads must use the in-PTY receiver protocol:

1. Use `write_text` to start a receiver CLI in the shell owner.
2. Wait for the observation to report owner kind `receiver` and a `receiverId`.
3. Send one base64 frame line per `write_text`; include the trailing `\n`.
4. Close by writing `__TAH_RECEIVER_END__ frames=<n> bytes=<n> sha256=<hash>\n`.

This keeps payload bytes out of shell quoting while preserving a pure PTY action surface. The receiver process validates frame order, byte count, and sha256 before committing the target.

## Non Goals

- No command-shaped bash tool payload.
- No separate text control action.
- No line-oriented PTY action.
- No model-visible file staging tool.
- No provider-native tool calling dependency.

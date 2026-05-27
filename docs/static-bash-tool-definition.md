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
  | { kind: "input_frame"; session?: string; expectedOwnerRevision: number; receiverId: string; seq: number; dataBase64: string }
  | { kind: "end_input"; session?: string; expectedOwnerRevision: number; receiverId: string; frames: number; bytes: number; sha256: string }
  | { kind: "poll"; session?: string; sinceSeq?: number }
  | { kind: "status"; session?: string }
  | { kind: "interrupt"; session?: string; expectedOwnerRevision?: number }
  | { kind: "terminate"; session?: string }
  | { kind: "restart"; session?: string; cwd?: string };
```

Important semantics:

- `write_text` writes exact text bytes. It does not append Enter. Include `\n` explicitly or use `{ kind: "key", key: "enter" }`.
- `key` is for terminal keys such as Enter, Ctrl-C, Ctrl-D, Escape, Tab, Up, and Down.
- `input_frame` and `end_input` are only valid while the terminal owner is a receiver.
- `poll`, `status`, `interrupt`, `terminate`, and `restart` are control actions over the PTY session, not shell commands.
- Every write-like action carries `expectedOwnerRevision`; stale revisions are rejected.

## Large Payloads

Generated files, IM replies, code blocks, and other multi-KB payloads must use the receiver protocol:

1. Use `write_text` to start a receiver CLI in the shell owner.
2. Wait for the observation to report owner kind `receiver` and a `receiverId`.
3. Send base64 chunks with `input_frame`.
4. Close with `end_input`, including frame count, byte count, and sha256.

This keeps payload bytes out of shell quoting and out of PTY paste buffers.

## Non Goals

- No command-shaped bash tool payload.
- No separate text control action.
- No line-oriented PTY action.
- No model-visible file staging tool.
- No provider-native tool calling dependency.

# Runtime Process Architecture

The runtime uses explicit, supervised process boundaries for long-lived runtime
capabilities. The goal is not to fork everything; the goal is
to make every long-lived process visible, owned, recoverable, and testable.

## Authorities

- `RunOrchestrator` owns run workflow state and transcript events.
- `processes.json` owns the current process registry snapshot.
- `runtime events` own audit/replay facts around process and capability
  lifecycle changes.
- `Terminal Host` owns PTY sessions, screen buffers, visual-line cursors, and
  terminal observations for the default run terminal path.
- `MCP runtime manager` owns project-scoped MCP runtime planning. Remote MCP
  endpoints are not local processes.
- `Codeq host` is an explicit `tiny-agent codeq host` process boundary.
- `Model gateway` owns the default run `ModelPort` boundary and provider
  isolation.

## Process Kinds

The shared registry supports:

- `run`
- `terminal-host`
- `pty-session`
- `mcp-server`
- `codeq-host`
- `model-gateway`

Team-launched worker executions are `run` process records owned by
`{scope: "team-member", teamId, memberId, runId}`.

Every process record has one lifecycle status:

```text
planned -> starting -> running -> stopping -> exited
planned -> starting -> running -> crashed
```

Terminal states are final. Restarting creates or updates a new lifecycle path
rather than mutating a crashed/exited process back to running.

## Recovery

Recovery reads durable state:

- process registry records
- runtime event offsets
- run transcripts
- run/session scoped files

Recovery does not treat the OS process table as business truth. OS process
inspection is an adapter input that can confirm or refute a durable record, but
the registry remains the named state owner.

## Compatibility Notes

Current compatibility paths are explicit:

- `tiny-agent run` launches a supervisor-recorded `tiny-agent terminal-host`
  child process for terminal/session tools.
- `ManagedTerminalRuntime` remains the internal implementation of
  `tiny-agent terminal-host` and direct terminal tests; it is not the run
  process terminal authority.
- `tiny-agent run` launches a supervisor-recorded `tiny-agent model-gateway`
  child process for model turns.
- `DeepSeekFimAdapter` remains the internal implementation of
  `tiny-agent model-gateway` for the DeepSeek provider; it is not constructed by
  the default run CLI path.
- `tiny-agent codeq` is explicit: one-shot commands use the CLI path and the
  long-lived LSP boundary is `tiny-agent codeq host` when called.
- MCP is explicit: configured local servers are planned as project-scoped MCP
  runtimes, while remote MCP endpoints are capability endpoints rather than
  local child processes.

Remaining compatibility paths should be removed or promoted only when a later
change makes a supervisor-owned process path the single current authority.

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
- `Codeq host` is a run-owned `tiny-agent codeq host --socket <run-socket>`
  sidecar launched by `tiny-agent run`.
- `Skill host` is a run-owned `tiny-agent skill host --socket <run-socket>`
  sidecar launched by `tiny-agent run`.
- `MCP host` is a run-owned `tiny-agent mcp host --socket <run-socket>`
  sidecar launched by `tiny-agent run`; MCP server business state still belongs
  to the configured MCP server, not to the public CLI process.
- `Model gateway` owns the default run `ModelPort` boundary and provider
  isolation.

## Process Kinds

The shared registry supports:

- `run`
- `terminal-host`
- `pty-session`
- `codeq-host`
- `skill-host`
- `mcp-host`
- `model-gateway`

Team-launched worker executions are `run` process records owned by
`{scope: "team-member", teamId, memberId, runId}`.

There is no separate `worker-run` process kind. A worker execution is a run
whose owner is a team member; team files are control-plane references and
observable facts around that run.

## Residency Classification

Use this rule before adding a resident process:

```text
live resource required -> independent stateful subprocess
durable file state is enough -> one-shot edger CLI
```

Independent stateful subprocesses hold live resources that cannot be fully
represented by files:

| Process kind | Live resource authority |
| --- | --- |
| `run` | Agent control flow, in-flight model/tool turns, child runtime ports |
| `terminal-host` | PTY fd, child shell process, screen buffer, visual-line cursor |
| `pty-session` | PTY fd and session child process |
| `codeq-host` | LSP process/session and open-document cache |
| `skill-host` | Run-scoped skill command queue, execution environment, environment event append boundary |
| `mcp-host` | MCP client request queue and MCP transport/session lifecycle |
| `model-gateway` | Provider stream, cancellation boundary, transport pipe |

Durable file operations still have explicit storage owners. Public CLI access
to Skill and MCP goes through the run-owned host socket; the host then performs
the file operation or adapter call at the boundary.

| Operation | Durable owner |
| --- | --- |
| IM pair/send/receive/ack | `im/` channel logs, metadata, and cursors |
| Team roster/member commands | `teams/<teamId>/events.jsonl` plus snapshot |
| Process registry queries/cleanup | `processes.json` |
| MCP registry edits | `mcp-servers.json`, served through `mcp-host` for public CLI calls |
| Run list/status/transcript/export | `runs/<runId>/` files |
| Skill discovery/status/review commands | `skills/` and `skill-runs/`, served through `skill-host` for public CLI calls |
| Project/config commands | Project config files |

These classifications are also encoded in
`src/runtime/process-classification.ts`, so docs and code share the same
current boundary.

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
- `tiny-agent run` launches a supervisor-recorded `tiny-agent codeq host`
  child process for code intelligence. Ordinary `tiny-agent codeq ...`
  commands are one-shot clients to the run-scoped host socket from
  `TAH_CODEQ_HOST_SOCKET`; there is no direct CLI fallback and no cross-run
  host sharing.
- `tiny-agent run` launches supervisor-recorded `tiny-agent skill host` and
  `tiny-agent mcp host` child processes. Ordinary `tiny-agent skill ...` and
  `tiny-agent mcp ...` commands are socket clients to `TAH_SKILL_HOST_SOCKET`
  and `TAH_MCP_HOST_SOCKET`; missing sockets fail explicitly. There is no
  direct CLI fallback and no cross-run host sharing.
- MCP is explicit: the project registry is durable configuration, while
  `tools`/`call` transport lifecycles run inside the run-owned MCP host. Local
  stdio MCP servers may be launched by the host for a request; remote MCP
  endpoints are contacted over HTTP/SSE from the host boundary.

Remaining compatibility paths should be removed or promoted only when a later
change makes a supervisor-owned process path the single current authority.

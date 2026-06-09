# Subagent Team Operating Guide

This guide documents the current lightweight team control plane. The team layer is a member roster and task/lifecycle coordination surface; it is not a mandatory workspace, branch, or ledger factory.

## Mental Model

Create a team, add members, assign work, and observe lifecycle facts.

```text
team create <teamId>
  -> team member add/update/status/heartbeat/terminate
  -> team task create/assign/start/succeed/fail/cancel
  -> team lifecycle lease/reaper/shutdown for run-scoped worker processes
```

Workspace layout, git branch policy, child ledgers, and QA protocol are instructions sent to workers through IM or metadata/evidence submitted by workers. They are not required fields in the team roster schema.

## Runtime Boundaries

| Layer | Responsibility |
| --- | --- |
| `team-roster.ts` | Pure member roster FSM. Durable people/control-plane truth. |
| `team.ts` | Pure task FSM for assignment, IM dispatch status, and task lifecycle. |
| `team-cli-adapter.ts` | Project-scoped effect boundary: load/save team state and post assignment instructions to run-scoped IM. |
| `directory-store.ts` | Explicit-port JSON snapshot store for `team/state.json`. |
| `local-worker-launcher.ts` | Optional adapter that can spawn a local worker process when explicitly asked. |
| `lifecycle-runtime-adapter.ts` | Lease, heartbeat, stale reaper, shutdown chain over run-scoped worker process facts. |
| TUI dashboard | Observer/control projection only. It does not orchestrate or bypass review. |

Core domain code does not read time, files, env, network, or process state. Those inputs arrive through explicit ports or typed snapshots.

## Member Roster

Required member fields:

- `memberId`
- `role`
- `channel`
- `status`

Optional member fields:

- `runId`
- `assignment`
- `currentTask`
- `lastHeartbeat`
- `lastEvidence`
- `metadata`

Use `metadata` for facts like workspace, branch, ledger id, capability labels, or service endpoints:

```bash
tiny-agent team member add coder-1 coder default \
  --metadata '{"workspace":"/work/coder-1","branch":"codex/p6/foo","ledgerId":"L-123"}'
```

These metadata values are observable facts, not scheduler obligations. The master agent may instruct a worker to create a workspace or branch, but the roster does not require or enforce that strategy.

## Common Commands

```bash
tiny-agent team create team-p6

tiny-agent team member add coder-1 coder default
tiny-agent team member list
tiny-agent team member show coder-1
tiny-agent team member update coder-1 --json '{"runId":"run-123","currentTask":"Fix TUI roster"}'
tiny-agent team member status coder-1 active
tiny-agent team member heartbeat coder-1 --evidence "commit abc123"
tiny-agent team member terminate coder-1 --reason "task complete"

tiny-agent team task create T-001 "Fix roster projection"
tiny-agent team task assign T-001 coder-1 --text "Fix roster projection and report commit/test evidence"
tiny-agent team task assign T-001 coder-1 --text-stdin < task-instructions.md
tiny-agent team task start T-001
tiny-agent team task succeed T-001 --output '{"commit":"abc123"}'
```

`task assign` is the normal dispatch path. It writes a user message to the assigned member's run-scoped IM inbox and records the dispatch chain in the task state:

```text
task_assigned -> task_dispatch_requested -> task_dispatch_sent
task_assigned -> task_dispatch_requested -> task_dispatch_failed
```

The assigned member must have `runId` set before dispatch. The channel alone is not enough for a product team because multiple worker runs may share a project state root.

Lifecycle commands are for run-scoped worker processes:

```bash
tiny-agent team lifecycle lease coder-1 --run run-123
tiny-agent team lifecycle lifecycle-status coder-1 --run run-123
tiny-agent team lifecycle reaper --run run-123 --threshold-ms 300000
tiny-agent team lifecycle shutdown coder-1 --run run-123 --execute --reason "stale heartbeat"
```

## Durable State

Project-scoped team state:

```text
~/.tiny-agent/projects/<projectId>/team/state.json
~/.tiny-agent/projects/<projectId>/team/events.jsonl
```

`team/state.json` contains both `roster` and `taskState`.

`team/events.jsonl` is the append-only team event stream. Each mutating command appends current facts before the snapshot is written:

```text
team_created
roster_event
task_event
```

The event stream is the canonical read source. The directory reader replays a valid `team/events.jsonl` first and only falls back to `team/state.json` when no event stream exists.

Run-scoped team state and lifecycle facts:

```text
~/.tiny-agent/projects/<projectId>/runs/<runId>/team/state.json
~/.tiny-agent/projects/<projectId>/runs/<runId>/team/events.jsonl
~/.tiny-agent/projects/<projectId>/runs/<runId>/supervisor/lifecycle-events.jsonl
~/.tiny-agent/projects/<projectId>/runs/<runId>/workers/<workerId>/state.json
```

`lifecycle-events.jsonl` is the audit trail for `heartbeat_recorded`, `lease_*`, `reaper_*`, and `shutdown_*`. The TUI team dashboard projects these events for humans; it does not own the lifecycle state.

## Operating Pattern

1. Create or select a team.
2. Add members with role and channel only.
3. Bind active worker runs back to roster members with `team member update <memberId> --json '{"runId":"run-..."}'`.
4. Send concrete instructions with `team task assign`; it dispatches through IM and records sent/failed.
5. Include workspace/git/ledger requirements inside the assignment text when needed.
6. Record optional facts as metadata or handoff evidence after they exist.
7. Use lifecycle lease/heartbeat/reaper/shutdown for worker processes.
8. Merge code through git and review gates outside the roster reducer.

## Design Rules

- Do not add provider-native tools for team workers.
- Do not make workspace, branch, or ledger mandatory roster fields.
- Do not let the TUI mutate runtime state directly.
- Do not keep compatibility paths for removed roster command names.
- Keep reducers pure and adapters explicit-port based.

Last updated: 2026-06-09.

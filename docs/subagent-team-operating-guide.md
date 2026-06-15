# Subagent Team Operating Guide

This guide documents the current lightweight team control plane. The team layer is a member roster and lifecycle coordination surface; work instructions are sent through IM. It is not a mandatory workspace, branch, or ledger factory.

## Mental Model

Create a team, add members, send work through IM, and observe lifecycle facts.

```text
tiny-agent team create <teamId>
  -> tiny-agent team member add/update/status/heartbeat/terminate
  -> tiny-agent im admin post --from user:main --to member:<teamId>/<memberId> --text <instruction>
  -> tiny-agent team lifecycle lease/reaper/shutdown for team-member-owned runs
```

Workspace layout, git branch policy, child ledgers, and QA protocol are instructions sent to workers through IM or metadata/evidence submitted by workers. They are not required fields in the team roster schema.

## Runtime Boundaries

| Layer | Responsibility |
| --- | --- |
| `team-roster.ts` | Pure member roster FSM. Durable people/control-plane truth. |
| `team-cli-adapter.ts` | Project-scoped effect boundary: load/save team roster state. |
| `directory-store.ts` | Explicit-port JSON snapshot store for `team/state.json`. |
| `local-worker-launcher.ts` | Optional adapter that can spawn a local worker process when explicitly asked. |
| `lifecycle-runtime-adapter.ts` | Lease, heartbeat, stale reaper, shutdown chain over explicit team member process facts. |
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

tiny-agent team --team team-p6 member add coder-1 coder default
tiny-agent team --team team-p6 member list
tiny-agent team --team team-p6 member show coder-1
tiny-agent team --team team-p6 member update coder-1 --json '{"runId":"run-123","currentTask":"Fix TUI roster"}'
tiny-agent team --team team-p6 member status coder-1 active
tiny-agent team --team team-p6 member heartbeat coder-1 --evidence "commit abc123"
tiny-agent team --team team-p6 member terminate coder-1 --reason "task complete"

tiny-agent team --team team-p6 member update coder-1 --json '{"assignment":{"id":"A-001","title":"Fix roster projection","status":"assigned"}}'
tiny-agent im admin pair --a user:main --b member:team-p6/coder-1 --kind a2a
tiny-agent im admin bind --run-id run-123 --self member:team-p6/coder-1 --peer user:main --kind a2a
tiny-agent im admin post --from user:main --to member:team-p6/coder-1 --text "Fix roster projection and report commit/test evidence"
tiny-agent im admin post --from user:main --to member:team-p6/coder-1 --text-stdin < assignment-instructions.md
```

`im admin post` is the external direct-file dispatch path. Use the roster to discover or record the member's `runId` and endpoint metadata; public IM owns delivery. The team roster can store an optional `assignment` label for observability, but it does not mirror IM delivery state.

Lifecycle commands require explicit team ownership. `--run` is an optional execution fact; it never selects or owns the team:

```bash
tiny-agent team lifecycle lease coder-1 --team team-main --run run-123
tiny-agent team lifecycle lifecycle-status coder-1 --team team-main --run run-123
tiny-agent team lifecycle reaper --team team-main --run run-123 --threshold-ms 300000
tiny-agent team lifecycle shutdown coder-1 --team team-main --run run-123 --execute --reason "stale heartbeat"
```

## Durable State

Team-scoped state:

```text
~/.tiny-agent/projects/<projectId>/teams/<teamId>/state.json
~/.tiny-agent/projects/<projectId>/teams/<teamId>/events.jsonl
~/.tiny-agent/projects/<projectId>/teams/<teamId>/members/<memberId>/state.json
~/.tiny-agent/projects/<projectId>/teams/<teamId>/runs/<runId>.json
~/.tiny-agent/projects/<projectId>/teams/<teamId>/supervisor/lifecycle-events.jsonl
```

`state.json` contains the projected `roster`. `events.jsonl` is the append-only team event stream and canonical read source. Each mutating command appends current facts before the snapshot is written:

```text
team_created
roster_event
```

`lifecycle-events.jsonl` is the audit trail for `heartbeat_recorded`, `lease_*`, `reaper_*`, and `shutdown_*`. The TUI team dashboard projects these events for humans; it does not own the lifecycle state.

## Operating Pattern

1. Create or select a team.
2. Add members with role and channel only.
3. Bind active team-member-owned runs back to roster members with `tiny-agent team member update <memberId> --json '{"runId":"run-..."}'`.
4. Optionally record a visible assignment label with `tiny-agent team --team <teamId> member update <memberId> --json '{"assignment":{...}}'`.
5. Ensure the member endpoint pair exists and is bound to the team-member-owned run.
6. Send concrete instructions with `tiny-agent im admin post --from user:main --to member:<teamId>/<memberId> --text ...`.
7. Include workspace/git/ledger requirements inside the assignment text when needed.
8. Record optional facts as metadata or handoff evidence after they exist.
9. Use lifecycle lease/heartbeat/reaper/shutdown for team-member-owned runs.
10. Merge code through git and review gates outside the roster reducer.

## Design Rules

- Do not add provider-native tools for team workers.
- Do not make workspace, branch, or ledger mandatory roster fields.
- Do not let the TUI mutate runtime state directly.
- Do not keep compatibility paths for removed roster command names.
- Keep reducers pure and adapters explicit-port based.

Last updated: 2026-06-09.

# Sub-agent Team Domain

本文记录 `src/subagent` 的当前边界。这里的 team 是轻量控制平面：管理成员、worker process lifecycle 和合并评审输入，不拥有任务 FSM，也不强制规定 workspace/git/ledger 策略。

## Decision

Sub-agent team 仍然优先保持纯状态域。它的核心不是“替 master 自动创建 17 个 workspace”，而是提供一个可测试、可审计、可恢复的团队事实模型：

```text
member roster events -> TeamRosterState
work instructions    -> public IM endpoint pair
lifecycle events     -> supervisor/lifecycle-events.jsonl
display projections  -> TUI team dashboard
```

Workspace、branch、child ledger、PR 流程是 assignment 指令或 worker evidence。它们可以放进 `TeamMember.metadata` 或 handoff evidence，但不是 roster 的必填 schema。

## Team Roster

`src/subagent/team-roster.ts` 是成员花名册 FSM。

```ts
type TeamMember = {
  memberId: string;
  role: string;
  channel: string;
  runId?: string;
  assignment?: { id: string; title?: string; status?: string };
  currentTask?: string;
  status: "active" | "idle" | "stale" | "offline" | "terminated";
  lastHeartbeat?: string;
  lastEvidence?: string;
  metadata?: Record<string, string>;
};
```

事件：

```text
member_added
member_updated
member_status_changed
member_heartbeat
member_terminated
```

Helper：

- `createTeamRosterState(teamId)`
- `applyTeamRosterEvent(state, event)`
- `summarizeTeamRoster(state)`
- `lookupMember(state, memberId)`
- `listMembersByRole(state, role)`
- `listMembersByStatus(state, status)`

Valid transitions：

| From | To |
| --- | --- |
| active | idle, stale, offline, terminated |
| idle | active, stale, offline, terminated |
| stale | active, idle, offline, terminated |
| offline | active, idle, stale, terminated |
| terminated | none |

## Directory Store

`src/subagent/directory-store.ts` stores active project-scoped `teams/<teamId>/` snapshots through explicit filesystem ports.

```text
~/.tiny-agent/projects/<projectId>/teams/<teamId>/state.json
~/.tiny-agent/projects/<projectId>/teams/<teamId>/events.jsonl
```

Snapshot:

```ts
type TeamDirectorySnapshot = {
  schemaVersion: number;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  roster: TeamRosterState;
};
```

`createTeamDirectorySnapshot(roster, now, createdAt?)` takes explicit time input. `readTeamDirectory` and `writeTeamDirectory` take an injected `FsPort`; the core module performs no hidden IO.

`team/events.jsonl` is now the append-only project-scoped fact stream:

```text
team_created
roster_event -> TeamRosterEvent
```

`team/events.jsonl` is the canonical source for reads. `team/state.json` is a snapshot projection written after event append for inspection and recovery, but `readTeamDirectory` replays a valid event stream first and only falls back to the snapshot when no event stream exists. Malformed event lines fail replay instead of silently producing a partial state.

## Work Dispatch

The team module does not provide task subcommands. Work instructions are explicit public IM messages sent to a member endpoint:

```bash
tiny-agent im pair --a user:main --b member:<teamId>/<memberId> --kind a2a
tiny-agent im bind --run-id <runId> --self member:<teamId>/<memberId> --peer user:main --kind a2a
tiny-agent im post --from user:main --to member:<teamId>/<memberId> --text "<instruction>"
```

If the instruction needs a durable label, store it as `TeamMember.assignment` with `tiny-agent team --team <teamId> member update <memberId> --json <patch>`. The roster records observable member facts; it does not mirror or acknowledge IM delivery.

## Team CLI

Current CLI surface:

```bash
tiny-agent team create <teamId>

tiny-agent team --team <teamId> member list [--role <role>] [--status <status>]
tiny-agent team --team <teamId> member show <memberId>
tiny-agent team --team <teamId> member add <memberId> <role> <channel> [--metadata <json>]
tiny-agent team --team <teamId> member update <memberId> --json <patch>
tiny-agent team --team <teamId> member status <memberId> <status>
tiny-agent team --team <teamId> member heartbeat <memberId> [--evidence <text>]
tiny-agent team --team <teamId> member terminate <memberId> [--reason <text>]

tiny-agent im post --from user:main --to member:<teamId>/<memberId> --text "<instruction>"
```

There is no compatibility path for removed roster command names. For non-lifecycle team commands, create a team first and pass `--team <teamId>`; state is stored under the project state root, not process-local memory.

## Local Worker Launcher

`src/subagent/local-worker-launcher.ts` is an optional adapter for local worker processes. It launches `tiny-agent run`; the resulting process record is still `kind: "run"` and is owned by `{scope: "team-member", teamId, memberId, runId}`. It can receive explicit `workspace`, `branch`, and `allowedActions` inputs because launching a local process may need them. When it writes to the roster, those facts are stored as `member.metadata`; they do not become required roster fields.

Launch effects are injected:

- `SpawnPort`
- `GitPort`
- `Clock`
- `IdGenerator`
- `RosterStorePort`
- `WorkerStatePort`

Failure stages use current member terms:

```text
checkout
spawn
worker_state
member_add
member_update
member_status
```

## Lifecycle Runtime

`src/subagent/lifecycle-runtime-adapter.ts` consumes explicit snapshots:

```ts
type TeamSnapshot = {
  rosterState: TeamRosterState;
  supervisorEvents: SupervisorLifecycleEvent[];
  createdAt: string;
  runId: string;
  processExistence?: Record<string, boolean>;
};
```

It provides:

- `recordHeartbeat`
- `enumerateWorkers`
- `runReaper`
- `requestShutdown`

The worker lifecycle layer keeps `workerId` in supervisor events for historical event compatibility. Active team-member process facts live under `teams/<teamId>/members/<memberId>/`, and the agent execution is a normal run referenced from `teams/<teamId>/runs/<runId>.json`.

## Status Projector

`src/subagent/status-projector.ts` derives worker health from explicit snapshots:

- `member: TeamMember`
- optional run snapshot
- optional IM snapshot
- optional ledger snapshot
- optional lifecycle template
- explicit config with `now`

It has no hidden clock, filesystem, network, or env reads. `done` requires corroboration from run finished or clean ledger plus zero risk flags.

## TUI Dashboard

`src/tui/team-dashboard-view-model.ts` projects:

- `team-overview`
- `team-roster`
- `active-tasks`
- `run-status`
- `merge-qa`
- `supervisor-lifecycle`

The TUI is a display/control surface, not another orchestrator. Display redaction remains display-only and must not feed back into runtime prompt/model context.

## Merge Queue

`src/subagent/master-merge-queue-adapter.ts` consumes explicit member, handoff evidence, and branch snapshots. Branch and workspace are evidence/merge facts, not roster requirements.

## Testing Contract

Key tests:

- `tests/subagent-team-roster.test.ts`
- `tests/subagent-directory-store.test.ts`
- `tests/team-cli.test.ts`
- `tests/team-cli-adapter.test.ts`
- `tests/subagent-local-worker-launcher.test.ts`
- `tests/subagent-lifecycle-runtime-adapter.test.ts`
- `tests/subagent-lifecycle-cli-adapter.test.ts`
- `tests/tui-team-dashboard-view-model.test.ts`

These tests pin the current rule: team creation manages members; isolation strategy is carried by instructions, metadata, or evidence.

See [subagent-team-operating-guide.md](subagent-team-operating-guide.md) for practical usage.

# Sub-agent Team Domain

本文记录 `src/subagent` 的当前边界。

## Decision

Sub-agent team 目前是一个纯状态域，不是完整 sub-agent runtime。它不启动 worker process，不调模型，不调 MCP，也不写文件。它提供的是未来 sub-agent 服务需要复用的可测试 FSM：

```text
SubAgentTeamEvent
  -> applySubAgentTeamEvent(state, event)
  -> next SubAgentTeamState | rejection | duplicate
```

这个设计先把任务、worker、分配、开始、完成、失败、取消、离线这些状态转移固定下来，避免未来接云端队列或 MCP worker 时把生命周期逻辑散落在外层服务里。

## State

```ts
type SubAgentTeamState = {
  teamId: string;
  tasks: Record<string, SubAgentTask>;
  workers: Record<string, SubAgentWorker>;
  appliedEventIds: string[];
};
```

Task status：

```text
queued -> assigned -> running -> succeeded
queued -> cancelled
assigned/running -> failed
assigned/running -> cancelled
```

Worker status：

```text
idle
busy
offline
```

`appliedEventIds` 用于幂等。重复 event id 返回 `duplicate`，不再次改变 state。

## Events

当前事件：

```text
task_submitted
worker_registered
task_assigned
task_started
task_succeeded
task_failed
task_cancelled
worker_offline
```

事件必须带 `eventId`。外层 runtime 如果来自队列、MCP、webhook 或人工 UI，都应先构造明确事件，再交给 reducer。

## Rejections

非法转移不会修改 state，而是返回结构化 rejection：

```text
task_exists
worker_exists
unknown_task
unknown_worker
task_not_assignable
task_not_startable
task_not_completable
task_terminal
worker_not_available
worker_task_mismatch
```

这对 AI-assisted maintenance 很重要：未来 agent 或服务扩展失败时，可以看到是哪个 transition 违反了 FSM，而不是靠日志猜。

## Summary Helpers

`summarizeSubAgentTeam(state)` 返回 counts 和 active assignments：

```ts
type SubAgentTeamSummary = {
  teamId: string;
  totalTasks: number;
  totalWorkers: number;
  tasksByStatus: Record<SubAgentTaskStatus, number>;
  workersByStatus: Record<SubAgentWorkerStatus, number>;
  activeAssignments: SubAgentAssignmentSummary[];
};
```

`listActiveSubAgentAssignments(state)` 给 TUI、CLI 或 cloud adapter 展示当前分配。

## Integration Boundary

未来接 runtime 时应保持这个边界：

```text
CLI / MCP / cloud queue / local worker process
  -> validate command/event envelope
  -> load durable SubAgentTeamState
  -> applySubAgentTeamEvent(...)
  -> persist state + outbox atomically
  -> publish effects outside reducer
```

不要在 reducer 内：

- 读文件
- 读时间
- 调模型
- 发网络请求
- 启动进程
- 写 transcript

这些都是外层 adapter / service 的职责。

## Current Scope

已实现：

- 纯 reducer
- 合并协议纯域 (merge-protocol)：master review checklist、merge order、conflict policy、feedback loop、gate evaluation
- duplicate event no-op
- invalid transition rejection
- worker offline 时释放/失败 active task
- summary helpers
- root barrel export
- 单元测试覆盖 happy path、failure、cancel、duplicate、invalid assignment、offline 和 summary

未实现：

- worker process runtime
- sub-agent CLI
- cloud queue
- MCP wrapper
- TUI sub-agent dashboard
- 自动任务拆分/调度策略

当前最准确的说法是：项目已经有 sub-agent team 的状态机基础设施，还没有实际 sub-agent execution service。

## Contact Registry Domain

P6-01 added `src/subagent/contact-registry.ts` — a pure domain module for team contact / personnel directory. This is durable runtime truth, not TUI state.

### WorkerContact

Each worker record includes:
- `workerId` — unique identity
- `role` — coder, reviewer, master, etc.
- `workspace` — filesystem path
- `branch` — git branch
- `runId` — current agent run id
- `imChannel` — IM channel for communication
- `ledgerId` — child ledger id
- `ticket` — { id, title, status }
- `currentTask` — human-readable task description
- `status` — WorkerContactStatus: active | idle | stale | offline | terminated
- `lastHeartbeat` — ISO timestamp
- `lastEvidence` — ISO timestamp of last work output
- `allowedActions` — set of allowed action categories

### Events

```
worker_registered → worker_updated → worker_status_changed → worker_heartbeat → worker_terminated
```

### Pure helpers

- `createContactRegistryState(registryId)` — init
- `applyContactRegistryEvent(state, event)` — pure FSM reducer with duplicate detection and invalid transition rejection
- `summarizeContactRegistry(state)` — summary with status/role counts and active workers
- `lookupWorker(state, workerId)` — direct lookup
- `listWorkersByRole(state, role)` / `listWorkersByStatus(state, status)` — filtered queries

### Valid transitions

| From | To |
| --- | --- |
| active | idle, stale, offline, terminated |
| idle | active, stale, offline, terminated |
| stale | active, idle, offline, terminated |
| offline | active, idle, stale, terminated |
| terminated | (none) |

### Integration boundary

Do not implement durable store, CLI, worker launcher, or TUI dashboard in this module. Those belong to P6-02/P6-03/P6-04/P6-08. The contact registry provides the pure state shape and FSM that those services consume.


## Directory Store (P6-02)

P6-02 adds `src/subagent/directory-store.ts` — a durable persistence layer for the contact registry with explicit ports.

### Layout boundary

| Scope | Path | Purpose |
|-------|------|---------|
| Project-scoped | `.tiny-agent/team/contact-registry.json` | Cross-run team registry snapshot |
| Project-scoped | `.tiny-agent/team/events.jsonl` | Team-level event log |
| Run-scoped | `.tiny-agent/runs/<runId>/team/contact-registry.json` | Per-run team state snapshot |
| Run-scoped | `.tiny-agent/runs/<runId>/team/events.jsonl` | Per-run team event log |

Project-scoped registry persists across runs; run-scoped state stays self-contained under `runs/<runId>/` per the state-layout contract.

### Explicit dependency ports

- **Time**: `createTeamDirectorySnapshot(state, now)` takes explicit ISO timestamp input. No hidden `new Date()`.
- **Filesystem**: `readTeamDirectory(fs, layout)` and `writeTeamDirectory(fs, layout, snapshot)` take an `FsPort` with `readFile`, `writeFile`, `mkdir`. The in-memory `createInMemoryFsPort()` is provided for testing. Production Node FS adapters live outside this module; consumers inject the FsPort.

### Three layers

1. **Path planner** — pure functions `planTeamDirectoryLayout(projectRoot)` and `planRunScopedTeamPaths(projectRoot, runId)`. No IO, no side effects.

2. **Snapshot schema** — `TeamDirectorySnapshot` wrapping `ContactRegistryState` plus `schemaVersion`, `registryId`, `createdAt`, `updatedAt`. Validation via `validateTeamDirectorySnapshot()`.

3. **Repository** — async `readTeamDirectory` and `writeTeamDirectory` with graceful error handling and automatic directory creation.

### Integration boundary

This module does NOT implement: CLI, worker launcher, TUI dashboard, file locking, or Node FS adapter. P6-03/P6-04/P6-08 consume these interfaces.

## Team CLI (P6-03)

`tiny-agent team` is a CLI surface for team task and contact management.
All subcommands output JSON envelope (`ok`, `tool`, `version`, `cwd`).

### Contact subcommands

```bash
# List all registered workers
tiny-agent team contact list

# Show worker details
tiny-agent team contact show <workerId>

# Register a new worker
tiny-agent team contact register <workerId> <role> <workspace> <branch> <imChannel> [allowedAction...]

# Update worker fields (JSON patch)
tiny-agent team contact update <workerId> --json '{"currentTask":"Inspect issue"}'

# Change worker status
tiny-agent team contact status <workerId> <active|idle|stale|offline|terminated>

# Record heartbeat (now)
tiny-agent team contact heartbeat <workerId>

# Terminate a worker
tiny-agent team contact terminate <workerId>
```

### Task subcommands

```bash
# Create a new task
tiny-agent team task create <taskId> <title>

# List all tasks and summary
tiny-agent team task list

# Show task details
tiny-agent team task show <taskId>

# Assign task to worker (worker must be registered)
tiny-agent team task assign <taskId> <workerId>

# Start task execution
tiny-agent team task start <taskId>

# Mark task as succeeded (optional JSON output)
tiny-agent team task succeed <taskId> [--output <json>]

# Mark task as failed
tiny-agent team task fail <taskId> <error>

# Cancel a task
tiny-agent team task cancel <taskId> [reason]
```

### Architecture notes

- **Contact state**: backed by P6-01 `contact-registry.ts` pure FSM; persisted through P6-02 `directory-store.ts` project-scoped layout.
- **Task state**: backed by `team.ts` pure FSM; currently in-memory only. Persistent task state is a future durable task-store concern.
- **CLI service layer**: `src/subagent/team-cli.ts` — pure command parsing and handler functions.
- **Binary entry**: `src/cli/team-entry.ts` and `src/cli/team-run.ts`.
- **Integration**: routed through `src/cli/main.ts` as `tiny-agent team ...`.


## Local Worker Launcher (P6-04)

P6-04 adds `src/subagent/local-worker-launcher.ts` — a local worker launcher domain with explicit ports.

This is a **local runtime/CLI launcher**, not a provider-native sub-agent tool. It provides:

- Pure planning functions: `planRunScopedWorkerPaths`, `planWorkerLaunch`, `buildSpawnCommand`
- Explicit effect ports: `SpawnPort`, `GitPort`, `Clock`, `IdGenerator`, `ContactStorePort`
- An async `launchLocalWorker(plan, effects)` orchestrator that executes launch steps:
  1. Register worker contact via `worker_registered` event (idempotent)
  2. Checkout target branch via git port
  3. Spawn worker process (`node dist/cli/main.js run`) via spawn port
  4. Update worker runId/currentTask via `worker_updated` event
  5. Set worker status to `active` via `worker_status_changed` event
- Structured result: `WorkerLaunchSuccess` or `WorkerLaunchFailure` with exact failure stage (`checkout`, `spawn`, `contact_register`, `contact_update`, `contact_status`) and evidence (branch, registeredEventId, runId, spawnResult, failedAt)
- All inputs explicit: no hidden `Date`, env, filesystem, or network reads
- Tests use fake ports only (no real git/process/clock/network)

### Integration boundary

- Consumes P6-01 `contact-registry` types and FSM
- Does NOT implement durable file storage — that is P6-02's responsibility
- Does NOT implement CLI entry points — launch is invoked programmatically
- Does NOT start real processes in tests — only fake spawn/git/contact ports

## Status Projector (P6-05)

P6-05 adds `src/subagent/status-projector.ts` — a pure status projector that derives worker status from explicit input snapshots. It is consumed by the master agent and TUI projection layer, not by another orchestrator.

### Design

- **Pure function**: `projectWorkerStatus(input)` takes explicit snapshots and returns a deterministic `WorkerStatusProjection`. No `Date.now()`, `process.env`, `fs`, network, or random.
- **Explicit inputs**: `WorkerContact`, optional `RunSnapshot`, `TranscriptSnapshot`, `ImSnapshot`, `LedgerSnapshot`, `LifecycleTemplate`, and `ProjectorConfig` (explicit `now` ISO timestamp and age thresholds).
- **Output**: `status` classification, `reason`, per-source `evidence` with timestamps and computed age, `riskFlags`, and `projectedAt`.
- **Status priority**: terminated > offline > done > stuck > degraded > idle > healthy > unknown.
- **Risk flags**: `stale_heartbeat`, `missing_heartbeat`, `missing_evidence`, `stale_evidence`, `im_silence`, `ledger_stall`, `run_stall`, `no_contact`.
- **"done" requires multiple signals**: run must be explicitly `finished` or ledger must show zero open problems with no risk flags. A single IM or display event cannot trigger false "done".
- **Lifecycle templates** allow per-role heartbeat thresholds (e.g., master checks in every 10 min, coder every 1 min).

### Integration boundary

- Consumes P6-01 `WorkerContact` type.
- Does NOT implement IM reading, transcript reading, ledger reading, or filesystem access — those snapshots are provided as explicit inputs by the caller.
- Does NOT determine merge readiness — that is a separate concern.
- The projector is exported from `src/subagent/index.ts`.

### Testing

Tests in `tests/subagent-status-projector.test.ts` cover: healthy, idle, offline, terminated, stale heartbeat, missing evidence, IM silence, run stall, ledger stall, stuck (multiple flags), done, false done avoidance, lifecycle thresholds, age computation, purity contract, and barrel export.

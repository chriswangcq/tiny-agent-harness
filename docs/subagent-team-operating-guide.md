# Subagent Team Operating Guide

This guide documents how to operate the P6 sub-agent team runtime. It covers architecture, worker roles, isolation model, concurrency scheduling, and collaboration flows. For detailed module specifications, see [subagent-team.md](subagent-team.md).

## Architecture Overview

The sub-agent team system has two layers:

**Agent Runtime** (src/subagent/*.ts): Pure domain modules implementing the team state machine, worker management, and merge protocol. These are consumed by the CLI and TUI layers. The runtime itself does not read files, start processes, or access the network — those are done by outer adapters.

**TUI/CLI Display**: The `tiny-agent team` CLI and TUI dashboard project worker and task state for human consumption. Display is a separate concern from the runtime domain.

### Worker Roles

| Role | Responsibility |
|------|---------------|
| **Coder** | Executes implementation tasks in a child workspace/branch |
| **QA** | Reviews coder output, runs gates, produces handoff evidence |
| **Merge** | Evaluates merge gates, merges PRs, creates post-merge verification |
| **Verifier** | Post-merge verification worker confirming merge correctness |

Workers register via `tiny-agent team contact register` and are tracked in the contact registry.

### Ledger Hierarchy

| Level | Description |
|-------|-------------|
| **Root ledger** | Master agent's ledger in the primary workspace. Serial, drives the overall plan. |
| **Child ledger** | Each worker has a `.complex-problems` child ledger in its workspace. Records worker-level problems/tickets/results/checks. |

The root ledger dispatches work; child ledgers execute it. Root ledger proceeds serially but workers execute concurrently.

## Isolation Model

Each worker operates in strict isolation:

| Isolation | Scope |
|-----------|-------|
| **Workspace** | Each worker gets a dedicated filesystem workspace directory |
| **Branch** | Each worker works on a dedicated git branch (e.g., `codex/p6/XX-...`) |
| **Run** | Each worker has its own `tiny-agent run` instance with a run-scoped state |
| **Channel** | Each worker has an IM channel for communication |

### Run-Scoped State

Run-scoped state lives under `.tiny-agent/runs/<runId>/`. Each run is self-contained and does not leak state across runs. Project-scoped state (e.g., team contact registry) persists across runs.

## Concurrency Scheduling Protocol

```
Root Agent (master workspace)
  ├── dispatches → Worker 1 (coder, workspace A, branch B1, run R1, child ledger L1)
  ├── dispatches → Worker 2 (QA, workspace B, branch B2, run R2, child ledger L2)
  └── dispatches → Worker N (...)
```

- **Root ledger is serial**: The master agent processes problems one at a time.
- **Workers are concurrent**: Multiple workers can execute simultaneously.
- **Merge requires full chain**: QA evidence → merge worker evaluation → post-merge verifier confirmation.

## Git PR/Merge Collaboration Flow

1. **Worker creates branch** from base.
2. **Coder** implements changes, commits, pushes.
3. **QA** reviews, runs typecheck/build/test gates, produces handoff evidence via `worker-handoff-evidence.ts` contract.
4. **Merge worker** evaluates `MasterReviewChecklist` gates (derived from handoff evidence), merges PR.
5. **Post-merge verifier** confirms merge correctness on the updated base.

### Handoff Evidence Contract

Every worker final report must include:
- `childLedgerId`, `childLedgerStatus` (must be "closed")
- `commit`, `branch`, `workspace`
- `changedFiles`, gate results (`typecheck`, `build`, `test`)
- `overallResult` (PASS/FAIL)
- `residualRisk`, `mergeRecommendation`

See `src/subagent/worker-handoff-evidence.ts` for the full contract schema.

## Capability Matrix

### Merged (P6-01 ~ P6-06)

| Phase | Module | Status |
|-------|--------|--------|
| P6-01 | `contact-registry.ts` — Worker contact FSM and pure state machine | ✅ Merged |
| P6-02 | `directory-store.ts` — Durable persistence with explicit ports | ✅ Merged |
| P6-03 | Team CLI (`tiny-agent team ...`) — Task and contact management | ✅ Merged |
| P6-04 | `local-worker-launcher.ts` — Local worker spawn with explicit effects | ✅ Merged |
| P6-05 | `status-projector.ts` — Pure worker status derivation from snapshots | ✅ Merged |
| P6-06 | `worker-handoff-evidence.ts` — Typed handoff contract and gate derivation | ✅ Merged |

### In Progress / Pending (P6-07 ~ P6-09)

| Phase | Planned Work | Status |
|-------|-------------|--------|
| P6-07 | Team runtime smoke tests | 🔄 In Progress |
| P6-08 | TUI sub-agent dashboard | ⏳ Pending |
| P6-09 | Cloud queue / MCP wrapper integration | ⏳ Pending |

These capabilities are not yet available and must not be relied upon.

## Practical Usage

### Registering Workers

```bash
tiny-agent team contact register <workerId> <role> <workspace> <branch> <imChannel>
tiny-agent team contact list
```

### Creating and Assigning Tasks

```bash
tiny-agent team task create <taskId> <title>
tiny-agent team task assign <taskId> <workerId>
tiny-agent team task start <taskId>
tiny-agent team task succeed <taskId> [--output <json>]
```

### Checking Worker Status

```bash
tiny-agent team contact show <workerId>
tiny-agent team task list
```

### Recording Worker Heartbeat

```bash
tiny-agent team contact heartbeat <workerId>
```

### Sending Final Report via IM

```bash
node dist/cli/main.js im send \
  --channel <channel> \
  --kind status \
  --text-stdin < /path/to/report.txt
```

Reports must include the handoff evidence fields required by the worker handoff contract.

## Supervisor Lifecycle Events

The supervisor maintains a run-scoped lifecycle ledger at `.tiny-agent/runs/<runId>/supervisor/lifecycle-events.jsonl`. This append-only JSONL records worker lifecycle facts that the TUI/team dashboard and stale-run reaper consume:

- **Heartbeat & lease**: when a worker calls `team contact heartbeat <workerId>`, the lifecycle adapter records a `heartbeat_recorded` event, updates the worker contact snapshot, and evaluates lease health. Duplicate heartbeats are idempotent.
- **Stale detection**: the reaper (`runReaper`) identifies stale active workers whose heartbeats have aged past configured thresholds. Workers with contact status `terminated` or `offline` are skipped.
- **Shutdown chain**: for each stale active worker, the reaper emits `shutdown_requested`, attempts a graceful shutdown, then records `shutdown_completed` or `shutdown_failed`. Successful shutdown marks the contact status `terminated`.
- **Lifecycle state**: the pure `computeLifecycleState` function derives `WorkerLifecycleState` (`healthy` / `stale` / `expired` / `grace_period` / `shutdown` / `terminated` / `missing_process` / `unknown`) from heartbeat age, process existence, and contact status.

These events are durable facts, not runtime internals. The TUI lifecycle audit projection reads `lifecycle-events.jsonl` directly to render worker lifecycle timelines without consulting agent state.

## Related Documents

- [subagent-team.md](subagent-team.md) — Detailed module specifications
- [agent-team-trial.md](agent-team-trial.md) — Trial notes
- [merge-protocol reference](../src/subagent/merge-protocol.ts) — Merge gate definitions

---

Last updated: 2026-06-06. Matches P6-01 through P6-06 at commit f2170a1.

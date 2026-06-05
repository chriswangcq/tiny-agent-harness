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

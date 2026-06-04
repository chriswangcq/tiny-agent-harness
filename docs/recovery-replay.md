# Recovery And Replay

本文记录 `src/run/recovery.ts` 和 `src/run/replay.ts` 的当前边界。

## Decision

Recovery / replay 是事实诊断和 eval case 构造层，不是副作用重放器。

```text
state.json + transcript.jsonl + session.json
  -> recovery diagnostics
  -> replay case
  -> eval summary
```

它们只消费显式传入的 snapshots 和 transcript events，不扫描文件系统、不启动 PTY、不调用模型、不重放 tool call。

## Recovery Diagnostics

入口：

```ts
diagnoseRunRecovery({
  state: AgentRunStateData | null,
  transcriptEvents: readonly RunEvent[],
  session: RunSessionSnapshot | null,
})
```

输出：

```ts
type RecoveryDiagnostics = {
  status: "healthy" | "recoverable" | "blocked";
  runId?: string;
  highestTranscriptStep: number;
  findings: RecoveryFinding[];
  suggestedActions: RecoveryAction[];
};
```

当前 finding codes：

```text
missing_state
missing_transcript_start
run_id_mismatch
missing_session_snapshot
session_run_id_mismatch
stale_state_step
```

严重程度：

```text
info | warn | error
```

如果存在 `error` finding，recovery status 是 `blocked`；只有 warning/info 时是 `recoverable`；没有 finding 时是 `healthy`。

## Recovery Actions

当前建议动作：

```text
resume_existing_state
inspect_transcript
rebuild_state_from_transcript
rebuild_session_from_transcript
start_new_run
```

这些是诊断建议，不是自动执行命令。真正的 resume 仍由 CLI/orchestrator 外层决定。

## Replay Case

入口：

```ts
buildReplayCase({
  state,
  transcriptEvents,
  session,
})
```

输出包含：

- `caseId`
- `runId`
- `task`
- `cwd`
- `status`
- `lastStepIndex`
- `stats`
- reconstructed `modelContextItems`
- `recovery`

Replay stats 当前统计：

```text
totalEvents
modelTurns
invalidModelOutputs
toolCalls
toolObservations
ioWaits
userMessages
agentMessages
```

`modelContextItems` 通过 transcript 重建，只用于 eval/debug/replay 输入分析。它不代表可以安全重放旧 PTY 副作用。

从 transcript 重建的 item 必须携带 provenance：

```text
provenance.kind = "transcript_replay"
provenance.stepIndex = <event stepIndex>
provenance.eventType = <source transcript event type>
provenance.eventTimestamp = <source transcript event timestamp>
```

运行时真实执行 terminal/session tool 后写入的 model-context item 使用 `provenance.kind = "runtime_effect"`。这两个标记只服务 recovery、eval、debug 和 session-store 审计；`ModelContextSession` 渲染 provider prompt 时不把 provenance 当作新的 tool request，也不能把 `transcript_replay` item 当作执行许可。

## Eval Summary

入口：

```ts
buildEvalCaseSummary(replayCase, {
  label,
  model,
  toolCatalogHash,
})
```

输出 compact summary，适合后续保存到 eval dataset 或 TUI run browser：

```ts
type EvalCaseSummary = {
  caseId: string;
  label?: string;
  runId: string;
  task: string;
  status?: AgentRunStatus;
  lastStepIndex: number;
  modelTurns: number;
  toolCalls: number;
  ioWaits: number;
  invalidModelOutputs: number;
  recoveryStatus: "healthy" | "recoverable" | "blocked";
  recoveryFindingCodes: string[];
  model?: string;
  toolCatalogHash?: string;
};
```

## Resume Semantics

Resume 恢复：

- run state
- transcript-derived or saved `ModelContextSession`
- environment/model context reminder

Resume 不恢复：

- 旧 PTY process tree
- 旧 foreground program
- in-flight tool execution
- ssh/vim/cat/REPL 等终端进程

恢复后 agent 必须先 `session_observe` / `session_list`，拿到 fresh shell 的最新 `terminal.inputSeq`，再决定下一步输入。

## Explicit Dependency Boundary

Recovery/replay 函数是纯逻辑：

- 不读当前时间
- 不读环境变量
- 不读文件系统
- 不写 transcript
- 不启动进程
- 不调用网络

文件读取、state root resolution、CLI 参数解析都应该留在外层 adapter。这样单元测试可以用显式 snapshots 复现所有判断。

## Non Goals

- 不自动 repair 坏 transcript。
- 不自动重放 tool call。
- 不启动旧 session。
- 不把 replay case 当作真实 run state。
- 不隐藏 recovery finding；blocked/recoverable 必须暴露给 TUI 或 CLI。

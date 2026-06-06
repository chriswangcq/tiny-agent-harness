# Agent Team Trial Plan

本文记录一次手动 agent team 试运行方案：把后续优化点拆成独立 ticket，每个 ticket 使用独立 workspace、agent run 和 git branch，由 master agent 持续辅导 worker，并负责 review / merge。

See [subagent-team-operating-guide.md](subagent-team-operating-guide.md) for the authoritative operating guide. This document records trial plans and details.
## Boundary

P6-01 到 P6-06 已合入 contact registry、directory store、team CLI 和 local worker launcher。这个文档记录 trial 操作层方案和当前状态：

- Runtime owns truth and effects: run state、transcript、environment events、PTY session、io_wait、tool review、model loop、recovery、CLI capability execution。
- TUI owns projection and user control gestures: transcript display、loop/debug detail、PTY screen projection、risk/review display、user message entry、control request entry。
- Worker 只能通过 terminal/session + CLI 能力执行，不能注册 provider-native tools。
- TUI 不能成为第二 orchestrator，不能绕过 runtime review。

## Per-Ticket Contract

每个 ticket 都分配：

```text
workspace: /Users/wangchaoqun/Documents/DeepSeek-agent-team/<ticket-slug>
run:       run-team-<ticket-slug>-<timestamp> 或 worker runtime 生成的 run-*
branch:    codex/team/<ticket-slug>
```

推荐创建方式：

```bash
mkdir -p /Users/wangchaoqun/Documents/DeepSeek-agent-team
git worktree add \
  /Users/wangchaoqun/Documents/DeepSeek-agent-team/<ticket-slug> \
  -b codex/team/<ticket-slug> \
  main
```

worker run 启动后，master 记录：

```json
{
  "ticket": "<ticket-slug>",
  "workspace": "/Users/wangchaoqun/Documents/DeepSeek-agent-team/<ticket-slug>",
  "runId": "run-*",
  "branch": "codex/team/<ticket-slug>",
  "status": "assigned|running|review_pending|merged|blocked"
}
```

## Ticket Map

### Agent Runtime Tickets

| Ticket | Purpose |
| --- | --- |
| `runtime-decision-trace` | 每次模型决策写 durable structured facts：thinking traceRef、promptRef、tool、args、validation、review、observation。 |
| `runtime-environment-events` | 治理 io_wait / environment event：低价值事件不 wake storm，用户消息 level 100 立即唤醒。 |
| `runtime-recovery-side-effects` | recovery/replay 不重复执行副作用 tool，区分 replayed facts 和 effects。 |
| `runtime-stuck-detection` | 连续无进展、重复 wait、重复错误时触发 circuit breaker / blocked reason。 |
| `runtime-tool-policy` | ToolPolicyReviewer 产品化，高危 terminal_write 分类，review 决策进入 transcript。 |
| `runtime-cli-capability-lifecycle` | MCP / skill / codeq / im 都保持 CLI-in-PTY 能力，统一 lifecycle、schema validation、JSON 输出。 |
| `runtime-token-cost-artifacts` | 每轮 token usage、promptRef、traceRef、成本相关 facts 进入 durable artifacts。 |

### TUI Tickets

| Ticket | Purpose |
| --- | --- |
| `tui-run-browser` | 历史 run 列表、状态、步数、耗时、失败摘要、attach/resume 入口。 |
| `tui-loop-detail-sections` | Loop detail 按 thinking / decision / validation / review / tool / observation / environment 分区展示。 |
| `tui-live-follow` | 流式 thinking、最新 loop detail、PTY projection 自动跟随；用户滚动后暂停 follow。 |
| `tui-pty-screen-projection` | PTY pane 只读展示 runtime screen buffer / display-only projection，不改 runtime rows/cols。 |
| `tui-review-control-panel` | 展示 pending review、risk reason、approve/cancel/pause/resume control request。 |
| `tui-token-dashboard` | 每轮 token、累计 token、cache token、估算成本展示。 |
| `tui-prompt-diff-viewer` | promptRef/context 变化 diff viewer，使用 artifact refs，不把大 prompt 塞进 detail。 |
| `tui-layout-display-stability` | pane 不重叠、宽度/UTF-8/control sequence 稳定、display redaction 不污染 runtime。 |

### Team Coordination Tickets

| Ticket | Purpose |
| --- | --- |
| `team-workspace-run-branch-protocol` | 定义 master 如何为每个 ticket 创建 workspace、run、branch，并记录映射。 |
| `team-master-merge-coaching` | 定义 master 如何持续辅导 worker、review 分支、跑 gates、处理冲突、merge 到 main。 |

## Master Loop

Master agent 每轮执行：

1. 查看所有 worker run 状态、latest transcript、branch diff。
2. 对 blocked / drifting worker 通过 IM 给出短指令。
3. 对 review_pending worker 执行代码审查、运行验证、检查 docs。
4. 对通过验证的 worker branch 按 merge order 合并。
5. 合并后跑 master workspace gates：

```bash
npm run typecheck
npm run build
npm test
```

6. push main，并把 merge result 回写到 team ledger / transcript。

## Worker Rules

worker 必须：

- 先读对应 ticket problem、README、相关 docs 和现有代码。
- 先补测试，再改代码。
- 保持改动只在自己的 branch/workspace。
- 不直接 merge main，不直接改 master workspace。
- 每次状态变化通过 IM / transcript 汇报：started、blocked、review_pending、done。
- 提交前跑 typecheck/build/test，或说明 narrower gate 的理由。

## Merge Protocol

Domain types and pure helpers live in `src/subagent/merge-protocol.ts`. They define the vocabulary and gate logic but do not perform runtime effects (git merge, test execution, branch checkout). Runtime owns truth/effects; this module owns the decision schema.

### 1. Master Review Checklist

Before merging a worker branch, master evaluates this structured checklist:

| Gate | Hard/Warn | Description |
|------|-----------|-------------|
| `workerReported` | Hard | Worker has reported run status (started/blocked/review_pending/done) |
| `runCompleted` | Hard | The agent run has reached a terminal state |
| `typecheckPasses` | Hard | `tsc --noEmit` passes |
| `buildPasses` | Hard | `tsc` passes on the worker branch |
| `testsPass` | Hard | `vitest run` passes on the worker branch |
| `noConflicts` | Hard | Worker branch has no merge conflicts with main |
| `diffReviewable` | Hard | Diff is non-empty, not excessively large, relevant files only |
| `noRevertOfOthers` | Hard | Worker branch does not revert or overwrite other workers' changes |
| `rebasedOnMain` | Warn | Branch is rebased on latest main (recommended, not required) |
| `workerRanGates` | Warn | Worker self-reported gate results before requesting review |
| `codeReviewed` | Warn | Master has performed substantive code review of the diff |

Hard gates block merge. Warnings are advisory.

The pure function `evaluateMergeGates(checklist)` returns `MergeGateResult`:
```ts
{
  passed: boolean;       // all hard gates passed
  failures: string[];    // specific failure messages
  warnings: string[];    // advisory warnings
}
```

### 2. Merge Order

Four priority classes, merged in order:

| Priority | Tickets | Constraint |
|----------|---------|------------|
| `runtime_truth` | `runtime-environment-events`, `runtime-recovery-side-effects`, `runtime-tool-policy` | Must merge first—changes runtime contract |
| `runtime_feature` | `runtime-decision-trace`, `runtime-stuck-detection`, `runtime-cli-capability-lifecycle`, `runtime-token-cost-artifacts` | Merges after runtime truth |
| `tui_projection` | All `tui-*` tickets | Only reads runtime facts; never merges before runtime truth |
| `cli_capability` | `team-*` coordination tickets | Merges last |

`canMergeNow(ticket, alreadyMergedSlugs)` enforces this order. `sortByMergePriority(tickets)` produces the ordered merge queue.

### 3. Conflict Policy

| Policy | Value |
|--------|-------|
| Default resolution | `worker_rebase` — master instructs worker to rebase and resolve |
| Fallback | After 3 unresponsive master review cycles, master may take over (`master_merge_fix`) |
| No timeout | If `fallbackAfterCycles` is null, master waits indefinitely |

### 4. Feedback Loop

Master coaches workers through each review cycle:

| Check | Description |
|-------|-------------|
| `cycleReview` | Master reviews all worker run states each cycle |
| `coachBlocked` | Master sends short IM instructions to blocked/drifting workers |
| `codeReview` | Master performs code review on `review_pending` branches |
| `reportMergeResult` | Master reports merge result back to worker via IM |

### 5. Gates (Master Workspace)

After merging a worker branch, master runs these gates in the master workspace before pushing:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc
npm test            # vitest run
```

If any gate fails after merge, master reverts the merge and reports failure to the worker.

### Relationship to Runtime/TUI Boundary

- **Runtime** owns: actual git operations, branch state, test execution, npm scripts, conflict detection.
- **TUI** may project: checklist state, merge queue, gate results, feedback loop status.
- **Domain (`merge-protocol.ts`)** defines: types, defaults, pure evaluation/logic. It has no side effects.
- Master agent wire-frames the above at the operational level until runtime automation exists.

## Ledger

本 trial 的 problem ledger：

```text
.complex-problems/L20260604-142908
```

该目录被 `.gitignore` 排除，只作为本地调度 ledger。项目级长期知识记录在本文档。

# Skill CLI Design

本文记录 tiny-agent-harness 第一版 skill CLI 设计。

## Decision

Skill 不是 harness 内置工具，也不是模型可见的第二套 tool registry。

第一版仍然坚持：

```text
Model visible tools: bash only
External capabilities: called as CLI commands inside bash
```

所以 skill 的入口是一个普通命令：

```bash
skill list --json
skill show coding-review --json
skill run coding-review --json '{"path":"src"}'
```

Agent 如果想使用 skill，本质上是在 `bash` tool call 里执行 `skill ...`。因此 skill 执行前仍然经过 bash tool review，执行结果也通过 bash observation 返回。

## Responsibilities

```text
Skill CLI
  owns: skill discovery, skill metadata, skill command invocation
  does not own: agent loop, model prompting, tool review, bash session runtime

BashSessionManager
  owns: running `skill ...` as a shell command
  owns: return code, incremental output, session log

RunOrchestrator
  sees: one normal bash tool call
  does not know: whether the command is skill, mcp, memory, test, or git
```

这个边界很重要：harness 不需要理解每个 skill 的业务语义。它只需要知道 bash 命令是否被批准、是否完成、输出在哪里。

## Non Goals

第一版明确不做：

- 把 skill 注册成 provider-native tool
- 在 harness 里加载 skill 代码
- 让 skill 绕过 bash session manager
- 让 skill 绕过 tool review
- 自动安装远程 skill
- 让模型直接调用 `skill` SDK

如果未来要做 self-evolving skill，也应该先产出候选文件，再由用户或审核模块确认启用。

## Skill Package

一个 skill 是一个目录。

建议目录结构：

```text
.tiny-agent/
  skills/
    coding-review/
      skill.json
      SKILL.md
      attachments/
        lessons.md
      bin/
        run
      examples/
        basic.json
  skill-runs/
    skillrun-2026-05-25-001/
      state.json
      execution.txt
      review-task.txt
```

最小可用 skill 可以只有：

```text
.tiny-agent/skills/<name>/SKILL.md
```

如果没有 `skill.json`，CLI 可以从 `SKILL.md` frontmatter 或首段描述里提取基本信息。

## Skill Manifest

`skill.json` 是可选但推荐的 manifest。

```ts
type SkillManifest = {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  entry?: string;
  argsSchema?: JsonSchema;
  outputContract?: "text" | "json" | "file";
};
```

字段含义：

- `name`: skill 名称，必须和目录名一致。
- `description`: 给 agent 搜索和理解用途的短描述。
- `version`: skill 自身版本，不影响 harness 协议。
- `tags`: 搜索标签。
- `entry`: `skill run <name>` 时执行的命令，默认可以是 `bin/run`。
- `argsSchema`: `skill run --json` 的参数约束。
- `outputContract`: 输出约定，第一版只作为文档提示，不作为 harness 强约束。

示例：

```json
{
  "name": "coding-review",
  "description": "Review code changes and report risks, regressions, and missing tests.",
  "version": "0.1.0",
  "tags": ["coding", "review"],
  "entry": "bin/run",
  "argsSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" }
    },
    "required": ["path"],
    "additionalProperties": false
  },
  "outputContract": "text"
}
```

## CLI Commands

第一版只需要 discovery 和 execution。

```text
skill list --json
skill search <query> --json
skill show <name> --json
skill run <name> --json '<args>'
skill status --active --json
skill close <skillRunId> --review none --json '<summary>'
skill close <skillRunId> --review required --json '<summary>'
skill review-complete <skillRunId> --json '<review>'
skill validate <name> --json
```

### list

列出本地可用 skill。

```bash
skill list --json
```

输出：

```json
{
  "skills": [
    {
      "name": "coding-review",
      "description": "Review code changes and report risks, regressions, and missing tests.",
      "tags": ["coding", "review"]
    }
  ]
}
```

### search

按关键词搜索本地 skill。

```bash
skill search review --json
```

输出同 `list`，但可以带 score：

```json
{
  "skills": [
    {
      "name": "coding-review",
      "description": "Review code changes and report risks, regressions, and missing tests.",
      "score": 0.92
    }
  ]
}
```

### show

展示单个 skill 的完整说明。

```bash
skill show coding-review --json
```

输出：

```json
{
  "name": "coding-review",
  "manifest": {
    "name": "coding-review",
    "description": "Review code changes and report risks, regressions, and missing tests.",
    "entry": "bin/run"
  },
  "readmePath": ".tiny-agent/skills/coding-review/SKILL.md",
  "content": "..."
}
```

`content` 需要截断，完整内容可以通过 `readmePath` 再用 bash 原生命令读取。

### run

执行 skill。

```bash
skill run coding-review --json '{"path":"src"}'
```

执行语义：

1. CLI 读取 skill manifest。
2. 如果存在 `argsSchema`，校验参数。
3. 创建一个 durable skill run record，状态为 `running`。
4. 在 skill 目录内执行 `entry`。
5. 参数通过 stdin 或环境变量传入 entry，第一版推荐 stdin。
6. entry 的 stdout/stderr 直接成为 `skill run` 的 stdout/stderr，同时写入 `execution.txt`。
7. entry 的 exit code 成为 `skill run` 的 exit code，并写入 `state.json`。

因此 harness 不需要特殊 observation。它只会看到普通 bash 命令：

```json
{
  "returnCode": 0,
  "output": "...",
  "outputLogPath": ".tiny-agent/sessions/default.log"
}
```

同时 `skill run` 应该输出 `skillRunId`，方便 agent 后续 close：

```json
{
  "ok": true,
  "skillRunId": "skillrun-2026-05-25-001",
  "skill": "coding-review",
  "status": "running",
  "statePath": ".tiny-agent/skill-runs/skillrun-2026-05-25-001/state.json",
  "executionLogPath": ".tiny-agent/skill-runs/skillrun-2026-05-25-001/execution.txt"
}
```

这里的 `running` 表示 skill 上下文仍然对 agent active，不一定表示 OS 进程还在运行。entry 命令可能已经完成，但 skill run 直到 `skill close` 前都持续出现在 system reminder 里。

### status

列出 active skill runs。

```bash
skill status --active --json
```

输出：

```json
{
  "activeRuns": [
    {
      "skillRunId": "skillrun-2026-05-25-001",
      "skill": "coding-review",
      "status": "running",
      "executionReturnCode": 0,
      "executionLogPath": ".tiny-agent/skill-runs/skillrun-2026-05-25-001/execution.txt"
    }
  ]
}
```

`status --active` 返回 `running` 和 `review_pending`，不返回 `closed`。

### close

关闭一个 active skill run。

```bash
skill close skillrun-2026-05-25-001 --review none --json '{"summary":"Used coding-review to check src changes."}'
```

如果不需要复盘：

```json
{
  "ok": true,
  "skillRunId": "skillrun-2026-05-25-001",
  "status": "closed"
}
```

如果需要复盘：

```bash
skill close skillrun-2026-05-25-001 --review required --json '{"summary":"Review found reusable test checklist gaps."}'
```

CLI 不直接把 run 从 reminder 里移除，而是创建 review task：

```json
{
  "ok": true,
  "skillRunId": "skillrun-2026-05-25-001",
  "status": "review_pending",
  "reviewTaskPath": ".tiny-agent/skill-runs/skillrun-2026-05-25-001/review-task.txt"
}
```

`review_pending` 会继续出现在每一轮 system reminder 里，直到复盘完成。

### review-complete

完成复盘，并把经验教训写回 skill 附件。

```bash
skill review-complete skillrun-2026-05-25-001 --json '{
  "summary": "The review skill should always inspect tests before proposing final confidence.",
  "lessons": [
    "When code changes touch run state, check transition tests and transcript persistence together."
  ]
}'
```

执行语义：

1. 读取 `review-task.txt`、`execution.txt` 和 `state.json`。
2. 把复盘摘要写入 skill run record。
3. 把可复用经验追加到 `.tiny-agent/skills/<skill>/attachments/lessons.md`。
4. 将 skill run 状态改为 `closed`。

输出：

```json
{
  "ok": true,
  "skillRunId": "skillrun-2026-05-25-001",
  "status": "closed",
  "lessonsPath": ".tiny-agent/skills/coding-review/attachments/lessons.md"
}
```

### validate

校验 skill 包结构，方便 agent 或用户调试。

```bash
skill validate coding-review --json
```

输出：

```json
{
  "ok": true,
  "errors": [],
  "warnings": []
}
```

## IO Contract

Skill CLI 必须遵守普通 Unix CLI 习惯。

输入：

- 小参数通过 flags 传入。
- 结构化参数通过 `--json '<args>'` 传入。
- 大输入通过文件路径传入，不直接塞进命令行。

输出：

- 正常结果输出到 stdout。
- 诊断信息输出到 stderr。
- 结构化模式下输出 JSON。
- 大结果写入文件，并在 stdout JSON 里返回路径。
- 非零 exit code 表示执行失败。

大输出示例：

```json
{
  "ok": true,
  "resultPath": ".tiny-agent/artifacts/skill-runs/coding-review-001.md",
  "summary": "Found 2 potential regressions."
}
```

这和 bash observation 的截断策略配合：observation 可以很短，但 agent 仍然能通过 `resultPath` 或 session log 翻页。

## Environment Integration

Skill CLI 不直接写 AgentRunState 的主生命周期，但它维护自己的 durable SkillRun state。RunOrchestrator 在每轮 model step 前把 active skill run 状态渲染为 persistent system reminder。

当 agent 运行：

```bash
skill run coding-review --json '{"path":"src"}'
```

事件流是：

```text
bash command starts
skill process runs inside the bash session
bash command finishes or times out
BashSessionManager appends command_finished or command_timed_out EnvironmentEvent
Skill CLI state keeps skillRun status as running until close
next agent loop renders active skill run as persistent reminder
```

如果 skill 自己需要等待外部 IO，第一版不要让它直接阻塞 agent state。它应该返回明确结果，或者由 agent 提交 `io_wait` 等待 environment 事件。

## Skill Run Lifecycle

Skill run 是一个子状态机。

```ts
type SkillRunStatus = "running" | "review_pending" | "closed";

type SkillRunState = {
  skillRunId: string;
  skill: string;
  status: SkillRunStatus;

  startedAt: string;
  closedAt?: string;

  args?: unknown;
  executionReturnCode?: number;
  executionLogPath: string;

  statePath: string;
  reviewTaskPath?: string;
  lessonsPath?: string;
};
```

Transition rules:

```text
missing + skill run
  -> running

running + skill close --review none
  -> closed

running + skill close --review required
  -> review_pending with review-task.txt

review_pending + skill review-complete
  -> closed with lessons appended

closed + any lifecycle command
  -> invalid unless command is read-only status/show
```

Reminder-active statuses:

```text
running
review_pending
```

`closed` 不再进入 system reminder。

## Skill Reminder

Skill reminder 是持续状态，不是一次性 event。

每轮 model step 前，orchestrator 或 prompt builder 读取 active skill runs，生成类似：

```text
Active skill reminder:
- [skillrun-2026-05-25-001] skill=coding-review status=running rc=0 log=.tiny-agent/skill-runs/skillrun-2026-05-25-001/execution.txt
- [skillrun-2026-05-25-002] skill=debugging status=review_pending task=.tiny-agent/skill-runs/skillrun-2026-05-25-002/review-task.txt
```

规则：

1. 每轮都插入 `running` 和 `review_pending`。
2. 不插入 `closed`。
3. 不插入完整执行日志，只插入路径、return code、状态和 review task 路径。
4. 如果 active skill 太多，保留最新 active runs，并汇总旧的数量。
5. Agent 完成使用后应该显式运行 `skill close`。
6. 如果 `review_pending` 存在，Agent 应该先阅读 review task，再运行 `skill review-complete`。

## Self Evolving Skills

“自进化 Agent” 可以把可复用经验沉淀成 skill，但第一版不自动启用。

后续可以加：

```text
skill propose <name> --json '<proposal>'
skill diff <proposal-id> --json
skill accept <proposal-id> --json
```

建议流程：

1. Agent 发现某个流程可复用。
2. Agent 生成 skill proposal 到 `.tiny-agent/skills/proposals/`。
3. Tool review 或用户审核 proposal。
4. 通过后移动到 `.tiny-agent/skills/<name>/`。
5. `skill list` 才能发现它。

这样避免 agent 自动写入一个看似权威但没有审核过的能力。

## Prompt Exposure

模型上下文里不需要塞所有 skill 内容。

推荐只在工具说明里告诉 agent：

```text
All external capabilities are available through bash commands.
Use `skill list --json`, `skill search <query> --json`, and `skill show <name> --json`
to discover reusable local skills.
Run a skill with `skill run <name> --json '<args>'`.
```

Agent 需要具体 skill 时，再通过 bash 自己查。

这保持 FIM prompt 小，同时让 skill 能通过文件系统持续增长。

## First Version Scope

第一版最小实现：

- `.tiny-agent/skills` 作为默认 skill root
- `.tiny-agent/skill-runs` 作为默认 skill run root
- `skill list --json`
- `skill show <name> --json`
- `skill run <name> --json '<args>'`
- `skill status --active --json`
- `skill close <skillRunId> --review none|required --json '<summary>'`
- `skill review-complete <skillRunId> --json '<review>'`
- `skill validate <name> --json`
- `SKILL.md` 必须存在
- `skill.json` 可选
- `entry` 可选，没有 entry 的 skill 只能 show，不能 run

可以暂缓：

- search ranking
- remote install
- skill dependency manager
- multi-root skill search path
- proposal accept workflow

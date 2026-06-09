# Skill CLI Design

本文记录 tiny-agent-harness 第一版 skill CLI 设计。

## Decision

Skill 不是 harness 内置工具，也不是模型可见的第二套 tool registry。

第一版仍然坚持：

```text
Model visible action surface: terminal/session PTY tools only
External capabilities: called as CLI commands through terminal_write when the current session screen shows a shell prompt
```

所以 skill 的入口是一个普通命令：

```bash
skill list --json
skill show coding-review --json
skill run coding-review --json '{"path":"src"}'
```

Agent 如果想使用 skill，本质上是在 PTY 里确认 shell prompt 后执行 `skill ...`。因此 skill 执行前仍然经过 tool review，执行结果也通过 PTY observation 返回。

## Responsibilities

```text
Skill CLI
  owns: skill discovery, skill metadata, skill command invocation
  does not own: agent loop, model prompting, tool review, PTY session runtime

ManagedTerminalRuntime
  owns: running `skill ...` as a shell command
  owns: return code, incremental output, session log

RunOrchestrator
  sees: one normal terminal_write action
  does not know: whether the command is skill, mcp, memory, test, or git
```

这个边界很重要：harness 不需要理解每个 skill 的业务语义。它只需要知道 bash 命令是否被批准、是否完成、输出在哪里。

## Non Goals

第一版明确不做：

- 把 skill 注册成 provider-native tool
- 在 harness 里加载 skill 代码
- 让 skill 绕过 PTY session manager
- 让 skill 绕过 tool review
- 自动安装远程 skill
- 让模型直接调用 `skill` SDK

如果未来要做 self-evolving skill，也应该先产出候选文件，再由用户或审核模块确认启用。

## Skill Package

一个 skill 是一个目录。

建议目录结构：

```text
~/.tiny-agent/projects/<projectId>/
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
  runs/
    run-<ts>/
      skill-runs/
        skillrun-2026-05-25-001/
          state.json
          execution.txt
          review-task.txt
```

最小可用 skill 可以只有：

```text
~/.tiny-agent/projects/<projectId>/skills/<name>/SKILL.md
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

当前实现包含 discovery、execution、close/review、validate、install。全生命周期命令均已实现。
子命令；安装仍是把本地 skill package 放入配置的 skills root。远程安装和依赖管理
属于后续产品面。

```text
skill list --json
skill show <name> --json
skill run <name> --json '<args>'
skill status --active --json
skill close <skillRunId> --review none --json '<summary>'
skill close <skillRunId> --review required --json '<summary>'
skill review-complete <skillRunId> --json '<review>'
skill install <source-path> [<name>] --json
skill validate <name> --json
```

### install

将一个本地 skill 目录安装到 skills root。

```bash
skill install /path/to/skill-dir --json
skill install /path/to/skill-dir custom-name --json
```

规则：

1. 源目录必须存在且包含 `SKILL.md`。
2. 默认使用源目录的 basename 作为 skill 名称，可通过第二个位置参数覆盖。
3. 目标名称不能在 skills root 中已存在。
4. 使用 `fs.cpSync` 递归复制整个目录树。
5. 安装是纯目录复制操作，不创建 skill run 记录也不发送环境事件。

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

### show

展示单个 skill 的元数据（不返回正文内容）。

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
  "readmePath": "~/.tiny-agent/projects/<projectId>/skills/coding-review/SKILL.md",
  "contentLineCount": 120
}
```

`skill show` 不返回正文内容。读取正文需通过 terminal 对 `readmePath` 执行分页命令：

```bash
# 先看行数（配合 contentLineCount 判断是否需要分页）
wc -l <readmePath>
# 逐页读取（每页 30 行）
sed -n '1,30p' <readmePath>
sed -n '31,60p' <readmePath>
```

不要使用 `more`/`less` 等交互式 pager。

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
  "outputLogPath": "~/.tiny-agent/projects/<projectId>/runs/<runId>/sessions/default-37a8eec1ce.log"
}
```

同时 `skill run` 应该输出 `skillRunId`，方便 agent 后续 close：

```json
{
  "ok": true,
  "skillRunId": "skillrun-2026-05-25-001",
  "skill": "coding-review",
  "status": "running",
  "statePath": "~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/skillrun-2026-05-25-001/state.json",
  "executionLogPath": "~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/skillrun-2026-05-25-001/execution.txt"
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
      "executionLogPath": "~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/skillrun-2026-05-25-001/execution.txt"
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
  "reviewTaskPath": "~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/skillrun-2026-05-25-001/review-task.txt"
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
3. 把可复用经验追加到 `~/.tiny-agent/projects/<projectId>/skills/<skill>/attachments/lessons.md`。
4. 将 skill run 状态改为 `closed`。

输出：

```json
{
  "ok": true,
  "skillRunId": "skillrun-2026-05-25-001",
  "status": "closed",
  "lessonsPath": "~/.tiny-agent/projects/<projectId>/skills/coding-review/attachments/lessons.md"
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
  "resultPath": "~/.tiny-agent/projects/<projectId>/artifacts/skill-runs/coding-review-001.md",
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
terminal_write action starts
skill process runs inside the current PTY session
terminal screen observation returns or requires session_observe
ManagedTerminalRuntime returns TerminalObservation through the tool-result path
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
- [skillrun-2026-05-25-001] skill=coding-review status=running rc=0 log=~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/skillrun-2026-05-25-001/execution.txt
- [skillrun-2026-05-25-002] skill=debugging status=review_pending task=~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/skillrun-2026-05-25-002/review-task.txt
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
2. Agent 生成 skill proposal 到 `~/.tiny-agent/projects/<projectId>/skills/proposals/`。
3. Tool review 或用户审核 proposal。
4. 通过后移动到 `~/.tiny-agent/projects/<projectId>/skills/<name>/`。
5. `skill list` 才能发现它。

这样避免 agent 自动写入一个看似权威但没有审核过的能力。

## Prompt Exposure

模型上下文里不需要塞所有 skill 内容。

推荐只在工具说明里告诉 agent：

```text
All external capabilities are available through terminal/session tool calls after the agent has inspected the terminal output.
Use `skill list --json`, `skill show <name> --json`, and `skill validate <name> --json`
to discover reusable local skills.
Run a skill with `skill run <name> --json '<args>'`.
```

Agent 需要具体 skill 时，再通过 bash 自己查。

这保持 FIM prompt 小，同时让 skill 能通过文件系统持续增长。

## First Version Scope

第一版最小实现：

- `~/.tiny-agent/projects/<projectId>/skills` 作为默认 skill root
- `~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs` 作为当前 run 的 skill run root（agent PTY 中通过 `TAH_SKILL_RUNS_DIR` 注入）
- `skill install <source-path> [<name>] --json` 将本地 skill 目录复制到 skills root。安装前校验 SKILL.md 存在且目标名称不冲突。
- `skill list --json`
- `skill show <name> --json`
- `skill run <name> --json '<args>'`
- `skill status --active --json`
- `skill close <skillRunId> --review none|required --json '<summary>'`
- `skill review-complete <skillRunId> --json '<review>'`
- `skill install <source-path> [<name>] --json`
- `skill validate <name> --json`
- `SKILL.md` 必须存在
- `skill.json` 可选
- `entry` 可选，没有 entry 的 skill 只能 show，不能 run

可以暂缓：

- search ranking
- remote install
- skill dependency manager
- multi-root skill discovery path
- proposal accept workflow

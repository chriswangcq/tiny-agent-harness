# Model Visible Tool Catalog

本文记录下一版 model-visible tool catalog。目标是把「向终端输入」和「管理 PTY session」拆开，并让所有 PTY observation 都对齐人类看终端的一屏内容。

## Decision

```text
Model-visible tools
  terminal_write
  terminal_key
  session_observe
  session_list
  session_focus
  session_interrupt
  session_restart
  session_terminate
  io_wait

Removed visible side channels
  legacy shell-wrapper tool
  legacy file-staging tool
```

核心约束：

1. `terminal_write` 和 `terminal_key` 永远只作用于 current session，schema 中没有 `session` 参数。
2. `session_focus` 是改变 current session 的唯一常规入口。
3. `session_observe` 可以观察 current session 或指定 session，但不会改变 current session。
4. 所有 PTY observation 都返回最多一屏 terminal viewport，不返回任意长度 tail，不做日志分页 API。
5. 完整 PTY 输出仍持久化在 session log；如果 agent 需要更多历史，使用 shell 原生命令读取日志，例如 `tail`、`sed`、`rg`、`less`。
6. `io_wait` 仍是等待 environment event 的 run-state decision，不是 shell 命令。

## Shared Observation

所有会观察 PTY 的工具返回同一种 terminal glance。它模拟人类执行动作后看一眼当前终端屏幕。

```ts
type TerminalObservation = {
  currentSession: string;
  observedSession: string;
  result: "ok" | "timeout" | "rejected" | "interrupted";
  terminal: TerminalFacts;
  returnedToPrompt: boolean;
  screen: PtyScreen;
  message?: string;
  errorCode?: string;
};

type TerminalFacts = {
  inputSeq: number;
  alive: boolean;
  syncStatus: "trusted" | "unsynced";
  lastShellPrompt: {
    cwd: string;
    promptSeq: number;
    returnCode: number | null;
  } | null;
  lastContinuationPrompt: {
    reason: "quote" | "heredoc" | "line_continuation" | "unknown";
    promptSeq: number;
  } | null;
  termination: {
    exitCode: number | null;
    reason: string;
  } | null;
  foregroundProcess: string | null;
};

type TerminalScreen = {
  text: string;
  rows: number;
  cols: number;
  truncated: boolean;
  logRef?: {
    path: string;
  };
};
```

`screen.text` 是当前 terminal viewport，不是旧的任意长度 tail 字段。`returnedToPrompt` 是普通命令编排的紧凑信号，表示这次观察看到了 shell 或 continuation prompt。`screen.truncated` 只表示屏幕之外可能还有历史；工具不会返回 offset 范围或日志页。更多内容必须通过 shell 原生命令查看 `screen.logRef.path`。

## Tool Schemas

### terminal_write

Description:

```text
Write exact text bytes to the current PTY session. This tool never accepts a session id.
Use it for shell commands, heredocs, REPL input, interactive answers, and stdin text.
It does not append Enter unless text contains "\n".
expectedInputSeq must match the current session's latest terminal.inputSeq.
By default, wait until a shell/continuation prompt returns or 30s elapses. Timeout does not kill the process.
The observation is a one-screen terminal glance after the write.
```

Schema:

```json
{
  "type": "object",
  "required": ["expectedInputSeq", "text"],
  "properties": {
    "expectedInputSeq": {
      "type": "number",
      "description": "The current session terminal.inputSeq observed before choosing this write."
    },
    "text": {
      "type": "string",
      "description": "Exact UTF-8 text bytes to write. Include newline explicitly when submitting a line."
    },
    "waitForReturnMs": {
      "type": "number",
      "description": "How long to wait for a shell or continuation prompt before returning a timeout observation. Defaults to 30000."
    }
  },
  "additionalProperties": false
}
```

### terminal_key

Description:

```text
Send a terminal key to the current PTY session. This tool never accepts a session id.
Use it for Enter, EOF-style input, escape/navigation, tab completion, and arrow navigation.
Use session_interrupt, not terminal_key, for Ctrl-C.
expectedInputSeq must match the current session's latest terminal.inputSeq.
The observation is a one-screen terminal glance after the key input.
```

Schema:

```json
{
  "type": "object",
  "required": ["expectedInputSeq", "key"],
  "properties": {
    "expectedInputSeq": {
      "type": "number",
      "description": "The current session terminal.inputSeq observed before choosing this key input."
    },
    "key": {
      "enum": ["enter", "ctrl-d", "escape", "tab", "up", "down", "left", "right"]
    },
    "waitForReturnMs": {
      "type": "number",
      "description": "How long to wait for a shell or continuation prompt before returning a timeout observation. Defaults to 30000."
    }
  },
  "additionalProperties": false
}
```

### session_observe

Description:

```text
Observe a PTY session without changing current session.
If session is omitted, observe current session.
Returns terminal.inputSeq, prompt facts, alive status, and the current terminal viewport screen.
Use this after long-running commands, timeouts, focus changes, restarts, or before writing to confirm the latest inputSeq.
This is not a log pagination API; read the persisted log path with shell-native tools when more history is needed.
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Optional session id to observe. Omit to observe current session."
    }
  },
  "additionalProperties": false
}
```

### session_list

Description:

```text
List all managed PTY sessions and identify the current session.
Use before switching sessions, recovering from a terminated session, or choosing where to inspect logs.
This tool returns structured session summaries, not PTY screens.
```

Schema:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

Return shape:

```ts
type SessionListObservation = {
  currentSession: string;
  sessions: Array<{
    session: string;
    current: boolean;
    alive: boolean;
    inputSeq: number;
    cwd?: string;
    foregroundProcess?: string | null;
    lastUpdatedAt?: string;
    summary: string;
  }>;
};
```

### session_focus

Description:

```text
Set the current PTY session. This is the only normal way to change where terminal_write and terminal_key go.
If create is true and the session does not exist, create it, optionally using cwd.
Does not write user text into the terminal.
Returns a one-screen observation for the newly focused session.
```

Schema:

```json
{
  "type": "object",
  "required": ["session"],
  "properties": {
    "session": {
      "type": "string",
      "description": "Session id to focus."
    },
    "create": {
      "type": "boolean",
      "description": "Create the session if it does not exist. Defaults to false."
    },
    "cwd": {
      "type": "string",
      "description": "Optional cwd for a newly created session."
    }
  },
  "additionalProperties": false
}
```

### session_interrupt

Description:

```text
Interrupt the current PTY session, equivalent to Ctrl-C/SIGINT semantics.
This tool never accepts a session id; foreground-impacting actions only affect current session.
Use it when a command is stuck, a REPL is waiting, or a long-running process should be stopped.
Timeout does not terminate the session; it only reports that no prompt returned in time.
The observation is a one-screen terminal glance after the interrupt.
```

Schema:

```json
{
  "type": "object",
  "required": ["expectedInputSeq"],
  "properties": {
    "expectedInputSeq": {
      "type": "number",
      "description": "The current session terminal.inputSeq observed before choosing this interrupt."
    },
    "waitForReturnMs": {
      "type": "number",
      "description": "How long to wait for a shell or continuation prompt before returning a timeout observation. Defaults to 30000."
    }
  },
  "additionalProperties": false
}
```

### session_restart

Description:

```text
Restart a managed PTY session. If session is omitted, restart current session.
This kills the existing PTY process tree for that session and starts a fresh shell.
It does not change current session unless the restarted session is already current.
Returns a one-screen observation with the fresh terminal.inputSeq for the restarted session.
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Optional session id to restart. Omit to restart current session."
    },
    "cwd": {
      "type": "string",
      "description": "Optional cwd for the restarted shell."
    },
    "reason": {
      "type": "string",
      "description": "Optional short reason for audit logs."
    }
  },
  "additionalProperties": false
}
```

### session_terminate

Description:

```text
Terminate a managed PTY session. If session is omitted, terminate current session.
If current session is terminated, currentSession remains that id but terminal_write and terminal_key will reject until the agent restarts or focuses a live session.
Use session_list, session_focus, or session_restart after terminating current session.
Returns structured termination facts and, when available, the final one-screen terminal glance.
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Optional session id to terminate. Omit to terminate current session."
    },
    "reason": {
      "type": "string",
      "description": "Optional short reason for audit logs."
    }
  },
  "additionalProperties": false
}
```

### io_wait

Description:

```text
Pause the agent loop until an external environment event arrives.
This is a tool call, not a shell command. Never run it inside the terminal.
Use after sending a user-visible reply, when waiting for user input, approval, webhook, sub-agent result, or another environment event.
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "description": "Optional short reason shown in the run loop."
    },
    "condition": {
      "oneOf": [
        {
          "type": "object",
          "required": ["kind"],
          "properties": {
            "kind": { "const": "new_environment_event" }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["kind"],
          "properties": {
            "kind": { "const": "new_user_message" },
            "channel": { "type": "string" }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "additionalProperties": false
}
```

## Payload Policy

普通文件、代码、Markdown、JSON、HTML 和 IM 回复都通过 `terminal_write` 中的 shell heredoc、stdin redirection 或项目内 CLI 完成。不存在额外文件暂存、frame action、receiver protocol 或二进制旁路。

对于非文本或很大的 payload，第一版仍保持「通过 shell 原生能力解决」的原则，例如：

```bash
base64 -d > artifact.bin <<'BASE64'
...
BASE64
```

或者让 agent 在一个 scratch/current session 中使用已有文件、下载命令、压缩命令、`cat`、`dd`、`python`、`node` 等普通 CLI 流程。所有这些动作仍然经过 terminal tool review、session log 和 transcript。

## Non Goals

- No command-shaped shell-wrapper tool.
- No file-staging side channel.
- No arbitrary log pagination in tool observation.
- No `session` parameter on write-like terminal tools.
- No provider-native tool calling dependency.

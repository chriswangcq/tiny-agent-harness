# Code Intelligence CLI Design

本文记录 tiny-agent-harness 的 code intelligence CLI 设计与当前实现。这个能力通过 `tiny-agent codeq` 暴露，`codeq` 含义是 code query。

## Decision

`tiny-agent codeq` 是一个普通 CLI 子命令，不是 harness 内置 tool，也不是模型可见的新工具。

它继续遵守当前边界：

```text
Model visible action surface: terminal/session PTY tools only
External capabilities: called as CLI commands through terminal_write when the current session screen shows a shell prompt
```

Agent 如果需要代码智能，本质上仍然是在 PTY 里确认 shell prompt 后执行：

```bash
tiny-agent codeq diagnostics --workspace --json
tiny-agent codeq symbols src/run/orchestrator.ts --json
tiny-agent codeq definition src/run/orchestrator.ts:37:18 --json
tiny-agent codeq references src/run/orchestrator.ts:37:18 --json
```

这样 LSP 能力会经过现有 PTY session、tool review、observation、transcript 和 log path，不会绕过审计边界。

当前实现是 **run-scoped all-host**：`tiny-agent run` 启动同生共死的
`tiny-agent codeq host --socket <runs/<runId>/codeq-host.sock>` sidecar，
TerminalHost env 注入 `TAH_CODEQ_HOST_SOCKET`。普通
`tiny-agent codeq ...` 只是 host client；没有 socket 时返回结构化失败，
不会创建 direct LSP backend，也不会跨 run 共享 host。

## Why

`rg`、`sed`、`tsc` 和测试已经足够支撑第一版 coding agent，但它们不擅长回答这些问题：

- 这个 symbol 的真实定义在哪里？
- 这个类型/函数被哪些地方引用？
- 当前光标位置的类型、签名或 hover 文档是什么？
- 这个文件里有哪些结构化 symbol？
- language server 已经知道哪些诊断？

`tiny-agent codeq` 给 agent 一个低噪声、结构化、可截断的代码理解入口。它不负责替 agent 思考，也不负责自动改代码。

## Responsibilities

```text
Codeq CLI
  owns: argv parsing, host-socket request, JSON output contract, error shape
  does not own: LSP process, workspace index, fallback direct execution

Codeq Host
  owns: run-scoped socket, reusable CodeIntel runtime/backend, LSP process/session
  owns: open-document cache and request serialization for its run
  does not own: agent loop, tool review, PTY runtime, transcript

CodeIntelBackend
  owns: selecting and speaking to one language server inside the host
  owns: LSP initialize/request/shutdown lifecycle for that host process
  owns: translating LSP locations and edits into CLI result objects

Codeq Host Process
  owns: run-owned subprocess, socket path, stderr log, crash reporting
  does not own: agent loop, tool review, PTY runtime, transcript

ManagedTerminalRuntime
  owns: running `tiny-agent codeq ...` as one shell command
  owns: command return code, output window, session log

RunOrchestrator
  sees: one normal terminal_write action
  does not know: whether the command is codeq, skill, test, git, or project script
```

The important split:

```text
tiny-agent codeq asks the language server for facts.
The agent decides what to do with those facts.
```

## Non Goals

第一版明确不做：

- 把 LSP 注册成 provider-native tool
- 跨 run 共享 CodeQ host 或 language server state
- 让 LSP 绕过 terminal/session tool review
- 让 CLI 默认修改文件
- 自动安装任意 language server
- 支持所有语言的完整差异
- 把 hover、diagnostic、references 的大输出原样塞回 prompt
- 替代 `rg`、`tsc --noEmit`、`vitest` 或人工阅读

`tiny-agent codeq` 是代码理解辅助，不是新的执行层。

## First Version Scope

当前版本支持 TypeScript / JavaScript，并优先使用 LSP server：

```text
typescript-language-server --stdio
```

当前实现的只读命令：

```text
tiny-agent codeq capabilities --json
tiny-agent codeq diagnostics [path] --json
tiny-agent codeq diagnostics --workspace --json
tiny-agent codeq symbols <path> --json
tiny-agent codeq workspace-symbols <query> --json
tiny-agent codeq definition <location> --json
tiny-agent codeq references <location> --json
tiny-agent codeq implementations <location> --json
tiny-agent codeq incoming-calls <location> --json
tiny-agent codeq outgoing-calls <location> --json
tiny-agent codeq hover <location> --json
```

当前版本只读。`rename` 和 `code-actions` 仍然只保留设计契约，不默认实现写入。

`diagnostics --workspace` 当前在 CodeQ host 内使用 TypeScript compiler
workspace diagnostics implementation：

```text
tsc --noEmit --pretty false
```

它和 LSP diagnostics 使用同一个 JSON result shape，并在 `backend.source`
标记为 `typescript-compiler`。这不是 public direct/fallback mode；普通
CLI 仍然必须通过 run-scoped CodeQ host。

## Location Format

CLI 对用户和 agent 暴露 human-friendly location：

```text
<path>:<line>:<column>
```

约定：

- `path` 可以是 workspace-relative path 或 absolute path。
- `line` 是 1-based。
- `column` 是 1-based。
- CLI 内部负责转换为 LSP 的 0-based line 和 UTF-16 character。
- JSON 输出同时保留 `uri`，方便未来跨 workspace 或外部文件定位。

示例：

```bash
tiny-agent codeq definition src/run/orchestrator.ts:37:18 --json
```

## JSON Envelope

所有 `--json` 输出使用同一个 envelope。

成功：

```json
{
  "ok": true,
  "tool": "codeq",
  "version": "0.1.0",
  "cwd": "/repo",
  "workspaceRoot": "/repo",
  "backend": {
    "languageId": "typescript",
    "server": "typescript-language-server",
    "serverCommand": ["typescript-language-server", "--stdio"],
    "capabilities": ["definition", "references", "documentSymbol", "hover"]
  },
  "query": {
    "command": "definition",
    "location": {
      "path": "src/run/orchestrator.ts",
      "line": 37,
      "column": 18
    }
  },
  "result": {},
  "limits": {
    "maxResults": 50,
    "previewLines": 2,
    "truncated": false
  }
}
```

失败：

```json
{
  "ok": false,
  "tool": "codeq",
  "version": "0.1.0",
  "cwd": "/repo",
  "error": {
    "code": "server_not_found",
    "message": "Could not find typescript-language-server on PATH.",
    "retryable": false
  }
}
```

Error code 建议保持稳定：

```text
invalid_args
unsupported_language
server_not_found
server_start_failed
server_timeout
server_crashed
capability_missing
file_not_found
parse_location_failed
request_failed
output_truncated
```

## Result Shapes

### capabilities

```bash
tiny-agent codeq capabilities --json
```

```json
{
  "ok": true,
  "result": {
    "languages": [
      {
        "languageId": "typescript",
        "fileExtensions": [".ts", ".tsx", ".js", ".jsx"],
        "available": true,
        "serverCommand": ["typescript-language-server", "--stdio"],
        "capabilities": ["diagnostics", "definition", "references", "documentSymbol", "hover"]
      }
    ]
  }
}
```

### diagnostics

```bash
tiny-agent codeq diagnostics --workspace --json
tiny-agent codeq diagnostics src/run/orchestrator.ts --json
```

```json
{
  "ok": true,
  "result": {
    "diagnostics": [
      {
        "path": "src/run/orchestrator.ts",
        "uri": "file:///repo/src/run/orchestrator.ts",
        "range": {
          "start": { "line": 37, "column": 18 },
          "end": { "line": 37, "column": 32 }
        },
        "severity": "error",
        "source": "typescript",
        "code": "2322",
        "message": "Type 'string' is not assignable to type 'number'.",
        "preview": "  const value: number = name;"
      }
    ]
  }
}
```

Ordering:

1. severity: error, warning, information, hint
2. path
3. start line
4. start column

`diagnostics --workspace` should prefer an LSP workspace diagnostic request when supported. If the server does not support it, TypeScript v1 may fall back to `tsc --noEmit` style diagnostics behind the same output shape, but the backend field must make that explicit.

### symbols

```bash
tiny-agent codeq symbols src/run/orchestrator.ts --json
```

```json
{
  "ok": true,
  "result": {
    "path": "src/run/orchestrator.ts",
    "symbols": [
      {
        "name": "RunOrchestrator",
        "kind": "class",
        "range": {
          "start": { "line": 44, "column": 1 },
          "end": { "line": 184, "column": 2 }
        },
        "selectionRange": {
          "start": { "line": 44, "column": 14 },
          "end": { "line": 44, "column": 29 }
        },
        "children": [
          {
            "name": "run",
            "kind": "method",
            "range": {
              "start": { "line": 72, "column": 3 },
              "end": { "line": 180, "column": 4 }
            }
          }
        ]
      }
    ]
  }
}
```

Default output should preserve hierarchy. Add `--flat` later only if needed.

### definition

```bash
tiny-agent codeq definition src/run/orchestrator.ts:37:18 --json
```

```json
{
  "ok": true,
  "result": {
    "definitions": [
      {
        "path": "src/types/tools.ts",
        "uri": "file:///repo/src/types/tools.ts",
        "range": {
          "start": { "line": 12, "column": 13 },
          "end": { "line": 12, "column": 24 }
        },
        "preview": "export type ToolRequest = {"
      }
    ]
  }
}
```

If there are multiple definitions, return all up to `--max-results`.

### workspace-symbols

```bash
tiny-agent codeq workspace-symbols RunOrchestrator --json
```

Use this when the agent knows a symbol name but not the owning file. Some
language servers can return only a URI without a range; in that case `range`
and `preview` are omitted instead of inventing a location.

### references

```bash
tiny-agent codeq references src/run/orchestrator.ts:37:18 --json
tiny-agent codeq references src/run/orchestrator.ts:37:18 --include-declaration --json
```

```json
{
  "ok": true,
  "result": {
    "references": [
      {
        "path": "src/run/orchestrator.ts",
        "uri": "file:///repo/src/run/orchestrator.ts",
        "range": {
          "start": { "line": 132, "column": 27 },
          "end": { "line": 132, "column": 38 }
        },
        "preview": "const decision = await this.ports.reviewer.review(effect.request);"
      }
    ]
  },
  "limits": {
    "maxResults": 50,
    "truncated": false
  }
}
```

### implementations

```bash
tiny-agent codeq implementations src/run/orchestrator.ts:37:18 --json
```

`implementation` is accepted as an alias for `implementations`.

### incoming-calls / outgoing-calls

```bash
tiny-agent codeq incoming-calls src/run/orchestrator.ts:37:18 --json
tiny-agent codeq outgoing-calls src/run/orchestrator.ts:37:18 --json
```

Call hierarchy is a two-step LSP flow internally: prepare the symbol at the
location, then ask for incoming or outgoing calls for the prepared item. The
CLI keeps the raw server item out of the JSON output and returns normalized
paths, ranges, and short previews.

### hover

```bash
tiny-agent codeq hover src/run/orchestrator.ts:37:18 --json
```

```json
{
  "ok": true,
  "result": {
    "contents": [
      {
        "kind": "markdown",
        "value": "type ToolRequest = ..."
      }
    ],
    "range": {
      "start": { "line": 37, "column": 13 },
      "end": { "line": 37, "column": 24 }
    }
  }
}
```

Hover output must be capped by byte length. If the LSP server returns long docs, include only the first safe slice and set `limits.truncated = true`.

## Edit Commands

Edit-producing commands are not implemented in the current CLI. `tiny-agent codeq` is
read-only today; `--apply` is rejected instead of being treated as a hidden
mutation path.

Future edit-planning commands can start as dry-run planners:

```text
tiny-agent codeq prepare-rename <location> --json
tiny-agent codeq rename <location> <new-name> --dry-run --json
tiny-agent codeq code-actions <path-or-range> --json
```

Future implementation rule:

```text
Read-only by default.
No command writes files unless a later product decision adds an explicit apply
mode with policy review.
```

If an apply mode is added later, `tiny-agent codeq` should emit the exact `WorkspaceEdit`
summary before writing, and the agent's terminal/session request still goes
through tool review. For the tiny-agent-harness first pass, keep `tiny-agent codeq`
read-only and let the agent apply edits through the normal patch workflow.

Dry-run rename output:

```json
{
  "ok": true,
  "result": {
    "workspaceEdit": {
      "changes": [
        {
          "path": "src/run/orchestrator.ts",
          "edits": [
            {
              "range": {
                "start": { "line": 37, "column": 13 },
                "end": { "line": 37, "column": 24 }
              },
              "newText": "newName"
            }
          ]
        }
      ]
    },
    "summary": {
      "filesChanged": 1,
      "edits": 1
    }
  }
}
```

## State Model

### Current: run-scoped host-only commands

`tiny-agent run` starts one `codeq-host` for the run:

```text
runs/<runId>/codeq-host.sock
runs/<runId>/codeq-host.json
runs/<runId>/codeq-host.stderr.log
```

TerminalHost receives:

```text
TAH_CODEQ_HOST_SOCKET=<runs/<runId>/codeq-host.sock>
TAH_CODEQ_HOST_RUN_ID=<runId>
```

Ordinary `tiny-agent codeq ...` is a one-shot CLI client to that socket. It
does not start an LSP backend itself. Missing socket is an error because the
current architecture has no direct fallback path.

The host is not a project daemon. It is run-owned, supervised by the run
process, recreated on resume, and disposed with the run sidecars.

## Configuration

V1 can work without config by auto-detecting:

- nearest `tsconfig.json`
- file extension
- `typescript-language-server` on PATH

Optional config path:

```text
~/.tiny-agent/projects/<projectId>/code-intel.json
```

Shape:

```json
{
  "defaultLanguage": "typescript",
  "languages": {
    "typescript": {
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
      "serverCommand": ["typescript-language-server", "--stdio"],
      "initializationOptions": {},
      "workspaceFiles": ["tsconfig.json", "package.json"]
    }
  },
  "limits": {
    "timeoutMs": 10000,
    "maxResults": 50,
    "previewLines": 2,
    "maxOutputBytes": 20000
  }
}
```

Config is an input, not hidden global state. Every JSON response should include the effective config path when one is used.

## Module Shape

Suggested source layout:

```text
src/code-intel/
  cli.ts
  commands.ts
  config.ts
  location.ts
  output.ts
  preview.ts
  workspace.ts
  lsp/
    client.ts
    protocol.ts
    process.ts
    typescript.ts
  __fixtures__/
```

Suggested ports:

```ts
type CodeIntelCommand =
  | { kind: "capabilities" }
  | { kind: "diagnostics"; path?: string; workspace: boolean }
  | { kind: "symbols"; path: string }
  | { kind: "definition"; location: SourceLocation }
  | { kind: "references"; location: SourceLocation; includeDeclaration: boolean }
  | { kind: "hover"; location: SourceLocation };

type SourceLocation = {
  path: string;
  line: number;
  column: number;
};

type CodeIntelBackend = {
  capabilities(): Promise<BackendCapabilities>;
  diagnostics(request: DiagnosticsRequest): Promise<DiagnosticsResult>;
  symbols(path: string): Promise<SymbolsResult>;
  definition(location: SourceLocation): Promise<LocationsResult>;
  references(request: ReferencesRequest): Promise<LocationsResult>;
  hover(location: SourceLocation): Promise<HoverResult>;
  dispose(): Promise<void>;
};
```

Keep `CodeIntelBackend` independent from argv and stdout. That makes command parsing, output shaping, and LSP behavior independently testable.

## LSP Lifecycle

For each run-scoped CodeQ host:

```text
resolve workspace root
select backend from file extension or config
spawn server command
send initialize
send initialized notification
serve JSONL socket requests from tiny-agent codeq clients
open target file when the request needs a textDocument
send the request
collect bounded result
return JSON envelope to the client
on host shutdown: send shutdown, send exit, dispose backend
```

Timeouts should apply to:

- process start
- initialize
- per-request wait
- shutdown

If shutdown times out, kill the child process and return the original command result if the request already succeeded. Include a warning field rather than failing a successful query due to cleanup.

## Output Limits

Defaults:

```text
--timeout-ms 10000
--max-results 50
--preview-lines 2
--max-output-bytes 20000
```

All result arrays must be bounded. If truncation happens:

```json
{
  "limits": {
    "maxResults": 50,
    "truncated": true,
    "omittedResults": 17
  }
}
```

Preview snippets should be read from disk, not trusted from the language server. This makes previews consistent and prevents server-specific formatting from becoming prompt noise.

## Testing Strategy

Use three test layers:

1. Pure unit tests
   - location parser
   - LSP 0-based / CLI 1-based conversion
   - UTF-16 character conversion
   - output envelope
   - sorting and truncation

2. Fake server integration tests
   - initialize/request/shutdown happy path
   - server timeout
   - server crash
   - malformed response
   - capability missing

3. TypeScript fixture tests
   - diagnostics on a tiny invalid project
   - definition across two files
   - references across two files
   - symbols for class/function/interface
   - hover on imported type

Do not make tests depend on a user's editor, global VS Code install, or existing language server unless the test is explicitly marked as an optional integration test.

## Implementation Phases

### Phase 1: read-only TypeScript CLI

- Done: add `tiny-agent codeq` subcommand.
- Done: add run-scoped host-only LSP client path.
- Done: support `capabilities`, `symbols`, `definition`, `references`, `hover`.
- Done: support `diagnostics <path>` via LSP publish diagnostics.
- Done: add tests with a fake LSP server and tiny TypeScript fixture.

### Phase 2: reliable diagnostics

- Done: add host-owned `diagnostics --workspace` with TypeScript compiler
  workspace diagnostics implementation.
- Done: keep the output shape identical to file diagnostics.
- Later: revisit LSP pull diagnostics if TypeScript language-server support becomes reliable enough.

### Phase 3: edit planning

- Add `prepare-rename`.
- Add `rename --dry-run`.
- Add `code-actions`.
- Keep the first edit-planning pass read-only; reject `--apply`.

### Phase 4: run host hardening

- Add file-version synchronization for long-lived opened documents.
- Add host health/status projection from the run process registry.
- Keep run ownership; do not add project-level shared daemon commands.

### Phase 5: multi-language

- Add language backend config.
- Add server capability negotiation.
- Keep command output stable even when server-specific details differ.

## Agent Usage Policy

Recommended prompt guidance for future agent instructions:

```text
Use `tiny-agent codeq` when semantic code navigation is cheaper or safer than reading by grep:
- definition/reference questions
- symbol maps for large files
- workspace symbol lookup when the file is unknown
- implementation and call hierarchy questions
- hover/type questions
- language-server diagnostics

Prefer rg and direct file reads for:
- text search
- broad repository discovery
- confirming exact source text
- simple local edits

Treat `tiny-agent codeq` output as evidence, not authority. If applying edits, inspect the target file and verify with typecheck/tests.
```

## Open Questions

- Should TypeScript v1 use `typescript-language-server` only inside the host, or allow a host-owned `tsserver` backend when LSP diagnostics are weak?
- Should `tiny-agent codeq diagnostics --workspace` eventually use host-owned LSP pull diagnostics instead of the current host-owned `tsc --noEmit --pretty false` implementation?
- Should previews include absolute file paths, workspace-relative paths, or both?
- What host health/status projection should TUI show from run process records?

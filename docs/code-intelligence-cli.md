# Code Intelligence CLI Design

本文记录 tiny-agent-harness 的 code intelligence CLI 设计与当前实现。这个 CLI 名为 `codeq`，含义是 code query。

## Decision

`codeq` 是一个普通 CLI，不是 harness 内置 tool，也不是模型可见的新工具。

它继续遵守当前边界：

```text
Model visible action surface: bash PTY actions only
External capabilities: called as CLI commands through write_text when TerminalOwner is shell
```

Agent 如果需要代码智能，本质上仍然是在 shell-owner PTY action 里执行：

```bash
codeq diagnostics --workspace --json
codeq symbols src/run/orchestrator.ts --json
codeq definition src/run/orchestrator.ts:37:18 --json
codeq references src/run/orchestrator.ts:37:18 --json
```

这样 LSP 能力会经过现有 PTY session、tool review、observation、transcript 和 log path，不会绕过审计边界。

## Why

`rg`、`sed`、`tsc` 和测试已经足够支撑第一版 coding agent，但它们不擅长回答这些问题：

- 这个 symbol 的真实定义在哪里？
- 这个类型/函数被哪些地方引用？
- 当前光标位置的类型、签名或 hover 文档是什么？
- 这个文件里有哪些结构化 symbol？
- language server 已经知道哪些诊断？

`codeq` 给 agent 一个低噪声、结构化、可截断的代码理解入口。它不负责替 agent 思考，也不负责自动改代码。

## Responsibilities

```text
Codeq CLI
  owns: argv parsing, workspace resolution, JSON output contract, limits, error shape
  does not own: agent loop, tool review, bash runtime, transcript

LanguageBackend
  owns: selecting and speaking to one language server
  owns: LSP initialize/request/shutdown lifecycle
  owns: translating LSP locations and edits into CLI result objects

ServerProcess
  owns: stdio process, timeout, stderr log, crash reporting
  does not own: business interpretation of results

ManagedTerminalRuntime
  owns: running `codeq ...` as one shell command
  owns: command return code, output window, session log

RunOrchestrator
  sees: one normal bash tool call
  does not know: whether the command is codeq, skill, test, git, or project script
```

The important split:

```text
codeq asks the language server for facts.
The agent decides what to do with those facts.
```

## Non Goals

第一版明确不做：

- 把 LSP 注册成 provider-native tool
- 在 harness 内部维护 language server 长连接
- 让 LSP 绕过 bash tool review
- 让 CLI 默认修改文件
- 自动安装任意 language server
- 支持所有语言的完整差异
- 把 hover、diagnostic、references 的大输出原样塞回 prompt
- 替代 `rg`、`tsc --noEmit`、`vitest` 或人工阅读

`codeq` 是代码理解辅助，不是新的执行层。

## First Version Scope

当前版本支持 TypeScript / JavaScript，并优先使用 LSP server：

```text
typescript-language-server --stdio
```

当前实现的只读命令：

```text
codeq capabilities --json
codeq diagnostics [path] --json
codeq diagnostics --workspace --json
codeq symbols <path> --json
codeq definition <location> --json
codeq references <location> --json
codeq hover <location> --json
```

当前版本只读。`rename` 和 `code-actions` 仍然只保留设计契约，不默认实现写入。

`diagnostics --workspace` 当前使用 TypeScript compiler fallback：

```text
tsc --noEmit --pretty false
```

它和 LSP diagnostics 使用同一个 JSON result shape，并在 `backend.source` 标记为 `typescript-compiler`。

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
codeq definition src/run/orchestrator.ts:37:18 --json
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
codeq capabilities --json
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
codeq diagnostics --workspace --json
codeq diagnostics src/run/orchestrator.ts --json
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
codeq symbols src/run/orchestrator.ts --json
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
codeq definition src/run/orchestrator.ts:37:18 --json
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

### references

```bash
codeq references src/run/orchestrator.ts:37:18 --json
codeq references src/run/orchestrator.ts:37:18 --include-declaration --json
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

### hover

```bash
codeq hover src/run/orchestrator.ts:37:18 --json
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

Edit-producing commands should be phase 2.

Recommended commands:

```text
codeq prepare-rename <location> --json
codeq rename <location> <new-name> --dry-run --json
codeq code-actions <path-or-range> --json
```

First implementation rule:

```text
Read-only by default.
No command writes files unless it has an explicit --apply flag.
```

Even with `--apply`, codeq should emit the exact `WorkspaceEdit` summary before writing, and the agent's PTY action still goes through tool review. For the tiny-agent-harness first pass, prefer `--dry-run` only and let the agent apply edits through normal patch workflow.

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

### V1: stateless commands

V1 should start the server, initialize, run one command, shutdown, and exit.

Benefits:

- no hidden process-local index state
- easy to test
- easy to reproduce from transcript
- no daemon cleanup problem
- good fit for current small TypeScript project

Cost:

- slower than a daemon
- workspace diagnostics may be expensive

This is acceptable for the first implementation because correctness and clear state matter more than speed.

### Later: explicit daemon

If startup cost becomes painful, add an explicit daemon mode rather than silently keeping background processes alive.

```text
codeq server start --workspace . --json
codeq server status --json
codeq server restart --json
codeq server stop --json
```

Daemon state should live under:

```text
.tiny-agent/code-intel/
  servers/
    <workspace-id>/
      state.json
      stderr.log
      requests.jsonl
```

Every daemon-backed result must include:

```json
{
  "serverState": {
    "mode": "daemon",
    "serverId": "codeq-ts-...",
    "workspaceGeneration": 12,
    "startedAt": "2026-05-25T00:00:00.000Z"
  }
}
```

Do not introduce daemon mode until there is a measurable performance reason.

## Configuration

V1 can work without config by auto-detecting:

- nearest `tsconfig.json`
- file extension
- `typescript-language-server` on PATH

Optional config path:

```text
.tiny-agent/code-intel.json
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

For each stateless command:

```text
resolve workspace root
select backend from file extension or config
spawn server command
send initialize
send initialized notification
open target file when the request needs a textDocument
send the request
collect bounded result
send shutdown
send exit
return JSON envelope
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

- Done: add `codeq` binary.
- Done: add stateless LSP client.
- Done: support `capabilities`, `symbols`, `definition`, `references`, `hover`.
- Done: support `diagnostics <path>` via LSP publish diagnostics.
- Done: add tests with a fake LSP server and tiny TypeScript fixture.

### Phase 2: reliable diagnostics

- Done: add `diagnostics --workspace` with a TypeScript compiler fallback.
- Done: keep the output shape identical to file diagnostics.
- Later: revisit LSP pull diagnostics if TypeScript language-server support becomes reliable enough.

### Phase 3: edit planning

- Add `prepare-rename`.
- Add `rename --dry-run`.
- Add `code-actions`.
- Do not write files by default.

### Phase 4: explicit daemon

- Add `codeq server start/status/restart/stop`.
- Persist daemon state and logs under `.tiny-agent/code-intel/`.
- Include daemon state in every result.
- Keep stateless mode as the default unless the user asks for daemon mode.

### Phase 5: multi-language

- Add language backend config.
- Add server capability negotiation.
- Keep command output stable even when server-specific details differ.

## Agent Usage Policy

Recommended prompt guidance for future agent instructions:

```text
Use codeq when semantic code navigation is cheaper or safer than reading by grep:
- definition/reference questions
- symbol maps for large files
- hover/type questions
- language-server diagnostics

Prefer rg and direct file reads for:
- text search
- broad repository discovery
- confirming exact source text
- simple local edits

Treat codeq output as evidence, not authority. If applying edits, inspect the target file and verify with typecheck/tests.
```

## Open Questions

- Should TypeScript v1 use `typescript-language-server` only, or allow a direct `tsserver` backend when LSP diagnostics are weak?
- Should `codeq diagnostics --workspace` eventually use LSP pull diagnostics instead of the current `tsc --noEmit --pretty false` fallback?
- Should previews include absolute file paths, workspace-relative paths, or both?
- Should daemon mode ever become default for TUI sessions, or stay opt-in forever?

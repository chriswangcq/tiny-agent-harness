# MCP CLI Design

本文记录 tiny-agent-harness 当前 MCP 接入方式。

## Decision

MCP 不是模型可见的新 tool registry，也不绕过 terminal/session 边界。第一版把 MCP 当作普通 CLI 能力：

```text
Agent model
  -> terminal_write("mcp ...")
  -> shell process
  -> mcp CLI
  -> MCP JSON-RPC server process
```

这意味着 MCP 能力增长不会改变 harness 内核。对 orchestrator 来说，`mcp tools`、`mcp call`、`skill run`、`codeq diagnostics`、`git`、`npm test` 都是同一类 terminal/session request：先 validation/review，再在 PTY 中执行，再通过一屏 observation 和 session log 回到模型。

## CLI Surface

入口：

```bash
mcp --help
mcp add <name> <command> [-- <server-args...>]
mcp remove <name>
mcp list
mcp tools <server>
mcp call <server> <tool> [--args-json '<json>']
```

也可以通过统一入口：

```bash
node dist/cli/main.js mcp list --json
tiny-agent mcp list --json
```

`--json` 可以放在命令前或命令后：

```bash
mcp --json list
mcp list --json
```

注册 server 参数时，`--` 后面的内容原样作为 server args。比如下面的 `--json` 是 server 参数，不是 `mcp` 输出模式：

```bash
mcp add docs-server node -- ./server.mjs --json
```

## State

MCP registry 存在 state root 下：

```text
~/.tiny-agent/projects/<projectId>/
  mcp-servers.json
```

当 agent 在 run PTY 里执行 `mcp ...` 时，shell 环境中的 `TAH_STATE_DIR` 默认指向当前 run dir。因此 MCP registry 默认是 run-scoped：

```text
~/.tiny-agent/projects/<projectId>/runs/<runId>/mcp-servers.json
```

人工调试时可以显式传 `--state-dir` 给 `tiny-agent mcp ...` 的外层入口，或设置 `TAH_STATE_DIR`。当前 `mcp` 独立 bin 读取 `TAH_STATE_DIR`，没有额外业务状态。

Project-scoped registry 只适合人类显式调试或预配置。Agent PTY 的默认路径必须来自
当前 run 的 `TAH_STATE_DIR`，这样 MCP server 注册、调用痕迹和失败都留在同一个
run audit boundary 内。

## Registry Schema

`McpRegistryStore` 维护 server 配置：

```ts
type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};
```

当前 CLI 支持 command 和 args；env 字段是 registry/client 层可承载的结构，第一版 CLI 不提供复杂 env 编辑命令。

## Transport

`ProcessMcpTransport` 用 child process stdio 跑 MCP server。`McpJsonRpcClient` 负责 JSON-RPC：

```text
initialize
tools/list
tools/call
disconnect
```

`mcp tools` 和 `mcp call` 每次都会启动 server、initialize、执行请求、disconnect。它不是 daemon，也不在 harness 内部保存长期 MCP process。

## Output Contract

普通输出是 key/value 风格，`--json` 输出单行 JSON：

```json
{"ok":true,"servers":[{"name":"demo","command":"node","args":["server.mjs"]}]}
```

错误写 stderr，exit code 非 0：

```json
{"ok":false,"error":"MCP server not found: demo"}
```

## Agent Usage Pattern

Agent 使用 MCP 时仍遵守 terminal/session 规则：

1. 先用 `session_observe` 确认 shell prompt 和最新 `terminal.inputSeq`。
2. 用 `terminal_write` 执行 `mcp ... --json`。
3. 如果输出超过一屏，通过 `screen.logRef.path` 用 `tail` / `sed` / `rg` 查看。
4. MCP call 的参数使用 `--args-json '<json>'`，复杂 payload 先写文件再由 server tool 读取。

示例：

```bash
mcp add local-docs node -- ./tools/mcp-docs-server.mjs
mcp tools local-docs --json
mcp call local-docs search --args-json '{"query":"run recovery"}' --json
```

## Non Goals

- 不把 MCP tools 直接注入模型可见 tool catalog。
- 不把 MCP server 作为长期后台 daemon 管理。
- 不让 MCP call 绕过 terminal/session tool review。
- 不在 harness 内核理解每个 MCP tool 的业务语义。

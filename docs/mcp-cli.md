# MCP CLI Design

本文记录 tiny-agent-harness 当前 MCP 接入方式。

## Decision

MCP 不是模型可见的新 tool registry，也不绕过 terminal/session 边界。MCP 被当作普通 CLI 能力：

```text
Agent model
  -> terminal_write("tiny-agent mcp ...")
  -> shell process
  -> tiny-agent mcp subcommand
  -> MCP JSON-RPC server process or remote MCP endpoint
```

这意味着 MCP 能力增长不会改变 harness 内核。对 orchestrator 来说，`tiny-agent mcp tools`、`tiny-agent mcp call`、`tiny-agent skill run`、`tiny-agent codeq diagnostics`、`git`、`npm test` 都是同一类 terminal/session request：先 validation/review，再在 PTY 中执行，再通过一屏 observation 和 session log 回到模型。

## CLI Surface

入口：

```bash
tiny-agent mcp --help
tiny-agent mcp add <name> <command> [-- <server-args...>]
tiny-agent mcp add <name> --url <url> [--header 'Name: Value'] [--transport http|sse]
tiny-agent mcp remove <name>
tiny-agent mcp list
tiny-agent mcp tools <server>
tiny-agent mcp call <server> <tool> [--args-json '<json>']
```

`--json` 可以放在命令前或命令后：

```bash
tiny-agent mcp --json list
tiny-agent mcp list --json
```

注册 server 参数时，`--` 后面的内容原样作为 server args。比如下面的 `--json` 是 server 参数，不是 `tiny-agent mcp` 输出模式：

```bash
tiny-agent mcp add docs-server node -- ./server.mjs --json
```

注册 remote MCP server 时，`--url` 进入远程模式。默认 transport 是 modern Streamable HTTP；旧 HTTP+SSE server 可以显式传 `--transport sse` 或 `--sse`：

```bash
tiny-agent mcp add ai-meditations \
  --url https://api.example.test/mcp \
  --header 'Authorization: Bearer <token>'

tiny-agent mcp add legacy-docs \
  --url https://legacy.example.test/sse \
  --transport sse
```

## State

MCP registry 存在 project state root 下：

```text
~/.tiny-agent/projects/<projectId>/
  mcp-servers.json
```

当 agent 在 run PTY 里执行 `tiny-agent mcp ...` 时，shell 环境同时包含当前
run 的 `TAH_STATE_DIR` 和项目级 `TAH_PROJECT_STATE_DIR`。MCP 默认读取
`TAH_PROJECT_STATE_DIR`，因此 registry 是 project-scoped，而不是 run-scoped：

```text
~/.tiny-agent/projects/<projectId>/mcp-servers.json
```

人工调试时可以显式传 `--state-dir` 给 `tiny-agent mcp ...` 的外层入口。显式
`--state-dir` 仍然优先于所有环境变量；如果没有 `TAH_PROJECT_STATE_DIR`，
CLI 会回退到 `TAH_STATE_DIR` 或默认 project resolver。

MCP server 注册是项目能力配置，应该跨 run 复用。具体 `tools` / `call`
命令仍然通过当前 run 的 PTY、transcript 和 session log 审计，所以调用痕迹和失败
仍留在 run audit boundary 内。

## Registry Schema

`McpRegistryStore` 维护 server 配置：

```ts
type McpServerConfig =
  | {
      name: string;
      type?: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      protocolVersion?: string;
    };
```

Registry file 中的 server entry 不重复保存 `name`。`tiny-agent mcp list` 会对敏感字段脱敏，例如 `Authorization`、`Cookie`、`X-Api-Key`、`token`、`secret`、`password` 等；registry 文件仍保存真实配置，供调用时使用。

## Transport

`createMcpTransport` 根据 registry config 选择 transport：

```text
stdio config -> ProcessMcpTransport
http config  -> HttpMcpTransport, Streamable HTTP
sse config   -> HttpMcpTransport, legacy HTTP+SSE endpoint mode
```

`ProcessMcpTransport` 用 child process stdio 跑 MCP server。`HttpMcpTransport` 通过 HTTP(S) 连接 remote MCP endpoint：

- Streamable HTTP：每条 JSON-RPC message 用 POST 发送；支持 `application/json` 和 `text/event-stream` 响应；如果 initialize response 返回 `MCP-Session-Id`，后续请求会自动带上。
- Legacy HTTP+SSE：先 GET 建立 SSE stream，读取 `endpoint` event 后，把后续 JSON-RPC message POST 到该 endpoint，响应从 SSE stream 读回。

`McpJsonRpcClient` 负责 JSON-RPC 生命周期：

```text
initialize
notifications/initialized
tools/list
tools/call
disconnect
```

`tiny-agent mcp tools` 和 `tiny-agent mcp call` 每次都会 initialize、执行请求、disconnect。对 stdio server 来说这意味着每次启动一个 server process；对 remote server 来说这意味着每次建立一个短生命周期 MCP client session。它不是 daemon，也不在 harness 内部保存长期 MCP process。

## Output Contract

普通输出是 key/value 风格，`--json` 输出单行 JSON：

```json
{"ok":true,"servers":[{"name":"demo","command":"node","args":["server.mjs"]},{"name":"remote","type":"http","url":"https://api.example.test/mcp","headers":{"Authorization":"<redacted>"}}]}
```

错误写 stderr，exit code 非 0：

```json
{"ok":false,"error":"MCP server not found: demo"}
```

## Agent Usage Pattern

Agent 使用 MCP 时仍遵守 terminal/session 规则：

1. 先用 `session_observe` 确认 shell prompt 和最新 `terminal.inputSeq`。
2. 用 `terminal_write` 执行 `tiny-agent mcp ... --json`。
3. 如果输出超过一屏，通过 `screen.logRef.path` 用 `tail` / `sed` / `rg` 查看。
4. MCP call 的参数使用 `--args-json '<json>'`，复杂 payload 先写文件再由 server tool 读取。

示例：

```bash
tiny-agent mcp add local-docs node -- ./tools/mcp-docs-server.mjs
tiny-agent mcp add remote-docs --url https://api.example.test/mcp --header 'Authorization: Bearer <token>'
tiny-agent mcp tools local-docs --json
tiny-agent mcp call local-docs search --args-json '{"query":"run recovery"}' --json
```

## Non Goals

- 不把 MCP tools 直接注入模型可见 tool catalog。
- 不把 MCP server 作为长期后台 daemon 管理。
- 不让 MCP call 绕过 terminal/session tool review。
- 不在 harness 内核理解每个 MCP tool 的业务语义。

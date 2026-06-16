export const HELP_TEXT = `tiny-agent — AI agent harness with terminal/session tools

Usage:
  tiny-agent run [--task <task>]                      Run, optionally wait for IM
  tiny-agent <task>                                   Alias for tiny-agent run --task <task>
  tiny-agent run --resume <runId|latest>              Resume an existing run
  tiny-agent resume <runId|latest>                    Resume an existing run
  tiny-agent ui [--state-dir <dir>]                   Open project UI console
  tiny-agent runtime <subcommand> [options]           Runtime replica control
  tiny-agent im  <subcommand> [options]               IM message operations
  tiny-agent skill <subcommand> [options]             Skill host client
  tiny-agent codeq <subcommand> [options]             CodeQ host client
  tiny-agent mcp  <subcommand> [options]              MCP host client
  tiny-agent team <group> [options]                   Team member/lifecycle control
  tiny-agent --help                                   Show this help

IM subcommands:
  tiny-agent im pair --a <endpoint> --b <endpoint>
                                                 Create IM pair via runtime replica
  tiny-agent im bind [--run-id <id>] [--self <endpoint>] [--peer <endpoint>]
                                                 Bind run endpoint via runtime replica
  tiny-agent im post --from <endpoint> --to <endpoint> --text <text>
                                                 Post user/work message via runtime replica
  tiny-agent im send --kind <status|error> --text-stdin
                                                 Send via runtime replica
  tiny-agent im recv [--cursor <id>]              Receive via runtime replica
  tiny-agent im ack --message-id <id>             Ack via runtime replica
  tiny-agent im run-recv [--run-id <id>]          Receive from run bindings via runtime replica
  tiny-agent im run-ack --message-id <id> [--peer <endpoint>]
                                                 Ack one run binding via runtime replica

Runtime subcommands:
  tiny-agent runtime replica --mode run --run-id <runId> --socket <path> --state-dir <dir>
                                                 Start run-owned runtime replica
  tiny-agent runtime replica --mode edge --edge-id <edgeId> --socket <path> --state-dir <dir>
                                                 Start external edge runtime replica
  tiny-agent runtime health                       Check runtime replica
  tiny-agent runtime capabilities                 List runtime replica capabilities

Skill subcommands:
  tiny-agent skill list                          List available skills
  tiny-agent skill show   <name>                 Show skill details
  tiny-agent skill run    <name>                 Execute a skill
  tiny-agent skill status [<runId>]              Check skill run status
  tiny-agent skill close  <runId>                Close a skill run
  tiny-agent skill review-complete <runId>       Complete skill review
  tiny-agent skill validate <name>               Validate skill structure
  tiny-agent skill install <source> [<name>]     Install a skill from local directory

Team groups:
  tiny-agent team create <teamId>          Create/reset lightweight team state
  tiny-agent team member <subcommand>      Team roster management
  tiny-agent team lifecycle <subcommand>   Run-scoped lease, lifecycle-status, reaper, shutdown

Work dispatch:
  tiny-agent im post --runtime-host-socket <edge-socket> --from user:main --to member:<team>/<member> --text <text>
                                            External edge work dispatch

Environment variables:
  DEEPSEEK_API_KEY   One-off override for providers.deepseek.apiKey
  DEEPSEEK_BASE_URL  One-off override for providers.deepseek.baseUrl
  MODEL_NAME         One-off override for providers.deepseek.model
  TAH_STATE_DIR      Override product state root
  TAH_RUNTIME_HOST_SOCKET Current run runtime replica socket
  TAH_CODEQ_HOST_SOCKET  Current run CodeQ host socket
  TAH_SKILL_HOST_SOCKET  Current run Skill host socket
  TAH_MCP_HOST_SOCKET    Current run MCP host socket

User config:
  ~/.tiny-agent/config.json

Most CLI subcommands accept --json for machine-readable output. Use --state-dir to override the product state root. IM operational commands require a runtime replica socket from the PTY environment or --runtime-host-socket; external tools should start an edge runtime replica and pass that socket. Skill, CodeQ, and MCP operational commands require their run host sockets.

Project UI commands:
  :new <task>      Start a new run and attach it
  :new             Start a run that waits for its first IM message
  :open <runId>    Attach an existing run without starting it
  :open latest     Attach the latest run
  :resume <runId>  Start an existing run process and attach it
  :stop [runId]    Request SIGTERM for a running run process
  :refresh         Reload the run list
`;

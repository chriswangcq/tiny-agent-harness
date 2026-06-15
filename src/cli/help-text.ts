export const HELP_TEXT = `tiny-agent — AI agent harness with terminal/session tools

Usage:
  tiny-agent run [--task <task>]                      Run, optionally wait for IM
  tiny-agent <task>                                   Alias for tiny-agent run --task <task>
  tiny-agent run --resume <runId|latest>              Resume an existing run
  tiny-agent resume <runId|latest>                    Resume an existing run
  tiny-agent ui  [--task <task>]                      Run + TUI in one command
  tiny-agent ui  --resume <runId|latest>
                                                        Resume + TUI in one command
  tiny-agent tui --run <runId|latest>                 Attach TUI to existing run
  tiny-agent im  <subcommand> [options]               IM message operations
  tiny-agent skill <subcommand> [options]             Skill host client
  tiny-agent codeq <subcommand> [options]             CodeQ host client
  tiny-agent mcp  <subcommand> [options]              MCP host client
  tiny-agent team <group> [options]                   Team member/lifecycle control
  tiny-agent --help                                   Show this help

IM subcommands:
  tiny-agent im send --kind <status|error> --text-stdin
                                                 Send via current run im-host
  tiny-agent im recv [--cursor <id>]              Receive via current run im-host
  tiny-agent im ack --message-id <id>             Ack via current run im-host
  tiny-agent im run-recv [--run-id <id>]          Receive from run bindings via im-host
  tiny-agent im run-ack --message-id <id> [--peer <endpoint>]
                                                 Ack one run binding via im-host
  tiny-agent im host --socket <path> --state-dir <dir>
                                                 Start a run-owned IM host
  tiny-agent im admin <subcommand> [--state-dir <dir>]
                                                 Direct-file admin/bootstrap IM

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
  tiny-agent im admin post --from user:main --to member:<team>/<member> --text <text>
                                            External direct-file work dispatch

Environment variables:
  DEEPSEEK_API_KEY   One-off override for providers.deepseek.apiKey
  DEEPSEEK_BASE_URL  One-off override for providers.deepseek.baseUrl
  MODEL_NAME         One-off override for providers.deepseek.model
  TAH_STATE_DIR      Override product state root
  TAH_IM_HOST_SOCKET Current run IM host socket
  TAH_IM_STATE_DIR   Project public IM state root for admin/edge commands
  TAH_CODEQ_HOST_SOCKET  Current run CodeQ host socket
  TAH_SKILL_HOST_SOCKET  Current run Skill host socket
  TAH_MCP_HOST_SOCKET    Current run MCP host socket

User config:
  ~/.tiny-agent/config.json

Most CLI subcommands accept --json for machine-readable output. Use --state-dir to override the product state root. IM, Skill, CodeQ, and MCP operational commands require a run host socket from the PTY environment or --host-socket; use tiny-agent im admin for explicit direct-file IM bootstrap/debug work.
`;

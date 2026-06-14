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
  tiny-agent im pair   --a <endpoint> --b <endpoint> [--kind <kind>]
                                                 Create/read a public endpoint pair
  tiny-agent im bind   --run-id <id> --self <endpoint> --peer <endpoint>
                                                 Bind a run to a public IM pair
  tiny-agent im post   --from <endpoint> --to <endpoint> --text <text>
                                                 Inject a user message
  tiny-agent im recv   --as <endpoint> --with <endpoint> [--cursor <id>]
                                                 Receive messages for an endpoint pair
  tiny-agent im send   --from <endpoint> --to <endpoint> --kind <status|error>
                                                 Send an agent message
  tiny-agent im ack    --as <endpoint> --with <endpoint> --message-id <id>
                                                 Acknowledge an endpoint-pair cursor
  tiny-agent im run-recv --run-id <id>            Receive messages from all run bindings
  tiny-agent im run-ack  --run-id <id> --peer <endpoint> --message-id <id>
                                                 Acknowledge one run binding peer channel

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
  tiny-agent im post --from user:main --to member:<team>/<member> --text <text>
                                            Send work instructions through public IM

Environment variables:
  DEEPSEEK_API_KEY   One-off override for providers.deepseek.apiKey
  DEEPSEEK_BASE_URL  One-off override for providers.deepseek.baseUrl
  MODEL_NAME         One-off override for providers.deepseek.model
  TAH_STATE_DIR      Override product state root
  TAH_CODEQ_HOST_SOCKET  Current run CodeQ host socket
  TAH_SKILL_HOST_SOCKET  Current run Skill host socket
  TAH_MCP_HOST_SOCKET    Current run MCP host socket

User config:
  ~/.tiny-agent/config.json

Most CLI subcommands accept --json for machine-readable output. Use --state-dir to override the product state root. Skill, CodeQ, and MCP operational commands require a run host socket from the PTY environment or --host-socket.
`;

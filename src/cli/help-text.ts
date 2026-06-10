export const HELP_TEXT = `tiny-agent — AI agent harness with terminal/session tools

Usage:
  tiny-agent <task>                                   Run with inline task
  tiny-agent run --channel <ch> [--task <task>]       Run, optionally wait for IM
  tiny-agent run --resume <runId|latest>              Resume an existing run
  tiny-agent resume <runId|latest>                    Resume an existing run
  tiny-agent ui  --channel <ch> [--task <task>]       Run + TUI in one command
  tiny-agent ui  --channel <ch> --resume <runId|latest>
                                                        Resume + TUI in one command
  tiny-agent tui --run <runId|latest>                 Attach TUI to existing run
  tiny-agent im  <subcommand> [options]               IM message operations
  tiny-agent skill <subcommand> [options]             Skill management
  tiny-agent codeq <subcommand> [options]             Read-only code intelligence queries
  tiny-agent mcp  <subcommand> [options]              MCP server interaction
  tiny-agent team <group> [options]                   Team member/task/lifecycle control
  tiny-agent --help                                   Show this help

IM subcommands:
  tiny-agent im post   --channel <ch> --text <text> [--run <runId|latest>]
                                                 Inject user message to inbox
  tiny-agent im recv   --channel <ch> [--cursor <id>]
                                                 Receive user messages from inbox
  tiny-agent im send   --channel <ch> --text <t>|--text-stdin --kind <k>
                                                 Send agent message to outbox
  tiny-agent im ack    --channel <ch> --message-id <id>
                                                 Acknowledge (advance cursor)
  tiny-agent im listen --channel <ch> [--cursor <id>]
                                                 Poll for new messages

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
  tiny-agent team task <subcommand>        Task lifecycle; assign dispatches instructions via IM
  tiny-agent team lifecycle <subcommand>   Run-scoped lease, lifecycle-status, reaper, shutdown

Environment variables:
  DEEPSEEK_API_KEY   One-off override for providers.deepseek.apiKey
  DEEPSEEK_BASE_URL  One-off override for providers.deepseek.baseUrl
  MODEL_NAME         One-off override for providers.deepseek.model
  TAH_IM_CHANNEL     Default IM channel (default: "default")

User config:
  ~/.tiny-agent/config.json

Most CLI subcommands accept --json for machine-readable output. Use --state-dir to override the product state root.
`;

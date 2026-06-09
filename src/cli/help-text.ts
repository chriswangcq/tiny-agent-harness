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
  tiny-agent mcp  <subcommand> [options]              MCP server interaction
  tiny-agent team <group> [options]                   Team member/task/lifecycle control
  tiny-agent --help                                   Show this help

IM subcommands:
  post   --channel <ch> --text <text> [--run <runId|latest>]
                                                 Inject user message to inbox
  recv   --channel <ch> [--cursor <id>]        Receive user messages from inbox
  send   --channel <ch> --text <t>|--text-stdin --kind <k>
                                                 Send agent message to outbox
  ack    --channel <ch> --message-id <id>      Acknowledge (advance cursor)
  listen --channel <ch> [--cursor <id>]        Poll for new messages

Skill subcommands:
  list                          List available skills
  show   <name>                 Show skill details
  run    <name>                 Execute a skill
  status [<runId>]              Check skill run status
  close  <runId>                Close a skill run
  review-complete <runId>       Complete skill review
  validate <name>               Validate skill structure
  install <source> [<name>]     Install a skill from local directory

Team groups:
  team create <teamId>          Create/reset lightweight team state
  team member <subcommand>      Team roster management
  team task <subcommand>        Task creation, assignment, execution, completion
  team lifecycle <subcommand>   Run-scoped lease, lifecycle-status, reaper, shutdown

Environment variables:
  DEEPSEEK_API_KEY   (required) API key for DeepSeek
  DEEPSEEK_BASE_URL  Base URL (default: https://api.deepseek.com/beta)
  MODEL_NAME         Model name (default: deepseek-v4-pro)
  TAH_IM_CHANNEL     Default IM channel (default: "default")

Most CLI subcommands accept --json for machine-readable output. Use --state-dir to override the product state root.
`;

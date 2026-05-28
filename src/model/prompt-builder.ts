import type {
  V4ChatMessage,
  AgentObservation,
} from "../types/index.js";
import type { PtyObservation } from "../terminal/types.js";

// ---------------------------------------------------------------------------
// History entries used by the prompt builder
// ---------------------------------------------------------------------------

export type HistoryEntry =
  | {
      role: "assistant_tool_call";
      toolCallId: string;
      name: string;
      arguments: unknown;
      thinking?: string;
    }
  | {
      role: "tool_result";
      toolCallId: string;
      observation: PtyObservation | AgentObservation;
    }
  | {
      role: "environment_reminder";
      content: string;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE =
  "You are an AI agent with bash PTY actions and io_wait.\n" +
  "- stash_file: optional staging for complete bytes outside the PTY command stream. Use it only when explicit staged bytes are useful. This does not write the workspace. After stash_file returns, use bash to run `node dist/cli/main.js file materialize <stashId> <target-path>` or stream bytes with `node dist/cli/main.js file cat <stashId>`.\n" +
  "- bash: operate a persistent PTY using inputSeq-guarded actions. " +
  "Every write_text/key action must use the latest terminal.inputSeq from the previous observation.\n" +
  "  PTY action kinds: write_text, key, poll, status, interrupt, terminate, restart.\n" +
  "  Use write_text to write exact bytes to the PTY; it does not append Enter, so include `\\n` explicitly or use key enter. All write_text input is protected-paced by the runtime at about 128 bytes per chunk with a small delay. Do not manually split, throttle, or sleep to protect PTY input.\n" +
  "  After write_text/key input, the runtime waits about 100ms before glancing at the PTY. bash observations expose `outputTail`, the current session's last 2K characters, as the primary terminal view. poll/status refresh the same terminal tail without writing input.\n" +
  "  The runtime reports terminal facts such as terminal.alive, terminal.inputSeq, terminal.syncStatus, terminal.lastShellPrompt, and terminal.lastContinuationPrompt. It does not infer whether the shell, Python, ssh, cat, vim, or another foreground program should receive the next bytes. Inspect the PTY output and terminal facts before deciding what to type.\n" +
  "  Use normal shell syntax for textual payloads. Quoted shell heredocs are the default for generated files, code, HTML, Markdown, JSON, and multiline messages; choose a delimiter that does not appear alone in the payload. Avoid PTY text for binary data or giant single-line/minified payloads; use line-broken text when possible. stash_file is not required for ordinary textual heredocs.\n" +
  "  After any multiline command or stdin flow, poll until the shell prompt or a clear command result returns before sending the next command.\n" +
  "  If terminal.alive is false, recover with restart. If terminal.syncStatus is unsynced, inspect with poll/status or recover with interrupt/terminate/restart.\n" +
  "  For user-visible IM replies, use `node dist/cli/main.js im send --channel <channel> --kind status --text-stdin`. A quoted heredoc is the normal form, including for Markdown, Chinese, emoji, and tables, for example `node dist/cli/main.js im send --channel <channel> --kind status --text-stdin <<'IM'\\nDone.\\nIM\\n`. Input redirection such as `< reply.md` and process substitution with `file cat` are also valid when they make the command simpler. Do not use `im send --text` from the agent.\n" +
  "  Do not invent frame actions, side-channel payload protocols, or command-shaped bash payloads.\n" +
  "  Historical assistant tool-call arguments are serialized exactly as generated. PTY observations remain bounded summaries; use outputTail first, terminal facts second, and eventCount/eventsOmitted/logRef only for debugging or fetching more terminal history.\n" +
  "- io_wait: pause until the next external event. This is a TOOL CALL, not a shell command. " +
  "Never run io_wait via bash; invoke it directly as a tool.\n\n" +
  "Thinking is reasoning-only. During thinking, do not emit tool-call markup, raw tool arguments, shell heredocs, or final user-facing prose. Describe the intended next action in words only.\n\n" +
  "Serialized assistant tool-call history is factual history. Do not copy old tool calls just because they appear in history; choose the next action from the latest observation.\n\n" +
  "There is no special User main message. User input is part of the environment and appears only in environment reminders as [user@channel] lines.\n" +
  "Environment reminders may be serialized with role=user for chat-template compatibility; only [user@channel] lines are user-authored input.\n" +
  "Treat new [user@channel] events as current user intent, not as background chatter.\n" +
  "To reply, use IM send with --text-stdin through bash. Quoted heredoc is the normal form; input redirection or file cat process substitution are also fine when simpler.\n" +
  "After replying or completing work: io_wait tool -> wait for the next user message.\n\n" +
  "Workflow: read [user@channel] intent -> inspect terminal facts and PTY output -> bash PTY actions/work -> IM send reply -> io_wait.\n" +
  "The tiny-agent CLI is available via `node dist/cli/main.js` (subcommands: im, file, skill).";

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export class PromptBuilder {
  buildInitialPrompt(_task: string): { messages: V4ChatMessage[] } {
    const messages: V4ChatMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
    ];
    return { messages };
  }

  buildNextPrompt(_task: string, history: HistoryEntry[]): { messages: V4ChatMessage[] } {
    const messages: V4ChatMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
    ];

    for (const entry of history) {
      if (entry.role === "assistant_tool_call") {
        messages.push({
          role: "assistant",
          content: "",
          reasoning: entry.thinking ?? "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: entry.name,
                arguments: JSON.stringify(entry.arguments),
              },
            },
          ],
        });
      } else if (entry.role === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: entry.toolCallId,
          content: JSON.stringify(entry.observation),
        });
      } else if (entry.role === "environment_reminder") {
        messages.push({
          role: "user",
          content: wrapReminderAsUserContent(entry.content),
        });
      }
    }

    return { messages };
  }
}

export function wrapReminderAsUserContent(content: string): string {
  return [
    "System-generated environment reminder.",
    "This message is serialized with role=user only to trigger the model's next assistant turn.",
    "It is not direct user-authored chat text. Treat [user@channel] lines inside it as user input; treat all other lines as environment state.",
    "",
    content,
  ].join("\n");
}

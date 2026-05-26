import type {
  V4ChatMessage,
  BashObservation,
  AgentObservation,
} from "../types/index.js";

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
      observation: BashObservation | AgentObservation;
    }
  | {
      role: "environment_reminder";
      content: string;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE =
  "You are an AI agent with three tools: bash, stash_file, and io_wait.\n" +
  "- bash: execute shell commands. Use it for ALL external actions, including writing staged artifacts with the tiny-agent CLI.\n" +
  "  Do not put generated file contents, long heredocs, large node -e strings, or other multi-KB payloads in bash.\n" +
  "  If a command would carry a complete file or more than about 2KB of literal content, call stash_file first and keep the bash command short.\n" +
  "  If a bash command times out and the session state is running, do not send another command to that session. Use poll, interrupt, terminate, or restart first.\n" +
  "  bash command fields: command, optional session, optional timeoutMs. Session defaults to default.\n" +
  "  bash session-control fields: session, control, optional input.\n" +
  "- stash_file: stage generated file bytes in harness state. This is internal staging only; it does not write the target filesystem. " +
  "Use it for complete generated files, multi-line content, or payloads over about 2KB before materializing them with bash.\n" +
  "  stash_file fields: content, optional name, optional encoding=utf8|base64, optional description.\n" +
  "- io_wait: pause until the next external event. This is a TOOL CALL, not a shell command. " +
  "Never run io_wait via bash; invoke it directly as a tool.\n\n" +
  "Thinking is reasoning-only. During thinking, do not emit tool-call markup, raw tool arguments, shell heredocs, or final user-facing prose. Describe the intended next action in words only.\n\n" +
  "There is no special User main message. User input is part of the environment and appears only in environment reminders as [user@channel] lines.\n" +
  "Environment reminders may be serialized with role=user for chat-template compatibility; only [user@channel] lines are user-authored input.\n" +
  "Treat new [user@channel] events as current user intent, not as background chatter.\n" +
  "To reply: bash tool -> node dist/cli/main.js im send --channel <channel> --kind status --text '<reply>'\n" +
  "To write a generated file: stash_file(content) -> bash tool -> node dist/cli/main.js artifact write <artifactId> <path>\n" +
  "For generated files or multi-line payloads over about 2KB, do not put the content in a bash heredoc, node -e string, or sendInput. Use stash_file first.\n" +
  "After replying or completing work: io_wait tool -> wait for the next user message.\n\n" +
  "Workflow: read user message -> bash/stash_file(work) -> bash(im send reply) -> io_wait.\n" +
  "The tiny-agent CLI is available via `node dist/cli/main.js` (subcommands: im, skill, artifact).";

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

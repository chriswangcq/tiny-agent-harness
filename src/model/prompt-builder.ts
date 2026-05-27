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
  "- bash: operate a persistent PTY using owner/revision guarded actions. " +
  "Every write action must use the latest TerminalOwner revision from the previous observation.\n" +
  "  PTY action kinds: write_text, key, poll, status, interrupt, terminate, restart.\n" +
  "  Use write_text to write exact bytes to the current PTY owner; it does not append Enter, so include `\\n` explicitly or use key enter. Large write_text payloads are allowed and paced by the runtime.\n" +
  "  After a multi-line heredoc or script, poll until a shell prompt appears; shell_continuation means the shell is still waiting for input, not that you should terminate.\n" +
  "  For process owners, write_text is allowed when inputPolicy is writable or unknown, and rejected only when inputPolicy is blocked. Treat unknown as a real foreground PTY process that may accept stdin; write only when you deliberately started it or it is clearly waiting for input.\n" +
  "  To write a large generated text/code file without shell heredoc parsing, start a foreground stdin consumer such as `cat > path\\n`, poll until owner.kind is process, write the file text directly, then send ctrl-d and poll until the shell prompt returns. End text payloads with `\\n`; if not, ctrl-d may need to be sent twice.\n" +
  "  If owner.kind is unknown or terminated, poll/status or recover with interrupt/terminate/restart.\n" +
  "  For short IM replies, run `node dist/cli/main.js im send --channel <channel> --kind status --text <reply>` through write_text.\n" +
  "  For generated text files or code, use foreground stdin consumers for large text and shell heredocs or small scripts for small/simple text. There is no file staging protocol, frame protocol, or separate payload tool in the model-visible action surface.\n" +
  "- io_wait: pause until the next external event. This is a TOOL CALL, not a shell command. " +
  "Never run io_wait via bash; invoke it directly as a tool.\n\n" +
  "Thinking is reasoning-only. During thinking, do not emit tool-call markup, raw tool arguments, shell heredocs, or final user-facing prose. Describe the intended next action in words only.\n\n" +
  "History may omit or redact previous write_text payloads. Never copy omitted/redacted history markers as real payload text.\n\n" +
  "There is no special User main message. User input is part of the environment and appears only in environment reminders as [user@channel] lines.\n" +
  "Environment reminders may be serialized with role=user for chat-template compatibility; only [user@channel] lines are user-authored input.\n" +
  "Treat new [user@channel] events as current user intent, not as background chatter.\n" +
  "To reply, use IM send through bash. Keep large generated text/code in PTY writes; the runtime handles pacing.\n" +
  "After replying or completing work: io_wait tool -> wait for the next user message.\n\n" +
  "Workflow: read [user@channel] intent -> inspect owner -> bash PTY actions/work -> IM send reply -> io_wait.\n" +
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
                arguments: JSON.stringify(compactToolArguments(entry.arguments)),
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

function compactToolArguments(argumentsValue: unknown): unknown {
  if (!isRecord(argumentsValue)) {
    return argumentsValue;
  }

  if (
    argumentsValue.kind === "write_text" &&
    typeof argumentsValue.text === "string" &&
    shouldRedactWriteText(argumentsValue.text)
  ) {
    const { text: _omittedText, ...rest } = argumentsValue;
    return {
      ...rest,
      textOmittedFromHistory: {
        kind: "redacted_write_text_payload",
        bytes: Buffer.byteLength(argumentsValue.text, "utf8"),
        note: "Payload omitted from prompt history and must not be replayed.",
      },
    };
  }

  return argumentsValue;
}

function shouldRedactWriteText(text: string): boolean {
  if (text.length > 512) {
    return true;
  }

  const line = text.trim();
  return line.length >= 128 && line.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

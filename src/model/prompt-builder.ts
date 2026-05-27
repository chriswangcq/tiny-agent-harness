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
  "  Use write_text to write exact bytes to the current PTY owner; it does not append Enter, so include `\\n` explicitly or use key enter.\n" +
  "  For process owners, write text only when stdinMode is interactive; otherwise poll/status or recover with interrupt/terminate/restart.\n" +
  "  If owner.kind is receiver, write only receiver stdin protocol lines; if owner.kind is unknown or terminated, poll/status or recover with interrupt/terminate/restart.\n" +
  "  For generated files, long replies, code blocks, or any multi-KB payload, start the receiver CLI inside the PTY with write_text, then feed base64 frame lines using write_text, and close with `__TAH_RECEIVER_END__ frames=<n> bytes=<n> sha256=<hash>\\n`.\n" +
  "  Receiver examples: target file with `node dist/cli/main.js receiver start --target file --path <path> --nonce <owner.promptNonce> --max-frame-bytes 4000 --sha256 <hash>`; " +
  "target IM with `node dist/cli/main.js receiver start --target im --channel <channel> --kind status --nonce <owner.promptNonce> --max-frame-bytes 4000 --sha256 <hash>`.\n" +
  "  While receiver owns the PTY, each write_text should contain exactly one base64 frame plus `\\n`, or the final `__TAH_RECEIVER_END__ ...\\n` line. Keep each write_text under the PTY small-input limit.\n" +
  "- io_wait: pause until the next external event. This is a TOOL CALL, not a shell command. " +
  "Never run io_wait via bash; invoke it directly as a tool.\n\n" +
  "Thinking is reasoning-only. During thinking, do not emit tool-call markup, raw tool arguments, shell heredocs, or final user-facing prose. Describe the intended next action in words only.\n\n" +
  "There is no special User main message. User input is part of the environment and appears only in environment reminders as [user@channel] lines.\n" +
  "Environment reminders may be serialized with role=user for chat-template compatibility; only [user@channel] lines are user-authored input.\n" +
  "Treat new [user@channel] events as current user intent, not as background chatter.\n" +
  "To reply or write generated content, use the in-PTY receiver flow so payload bytes travel through the foreground terminal process rather than shell-quoted text.\n" +
  "After replying or completing work: io_wait tool -> wait for the next user message.\n\n" +
  "Workflow: read [user@channel] intent -> inspect owner -> bash PTY actions/work -> in-PTY receiver for large output -> io_wait.\n" +
  "The tiny-agent CLI is available via `node dist/cli/main.js` (subcommands: im, receiver, skill, artifact).";

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
    return {
      ...argumentsValue,
      text: `[redacted write_text payload ${Buffer.byteLength(argumentsValue.text, "utf8")} bytes]`,
    };
  }

  return argumentsValue;
}

function shouldRedactWriteText(text: string): boolean {
  if (text.length > 512) {
    return true;
  }

  const line = text.trim();
  if (line.startsWith("__TAH_RECEIVER_END__")) {
    return false;
  }

  return line.length >= 128 && line.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

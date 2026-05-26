import type {
  ModelPrompt,
  ModelPromptMessage,
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
  "You are an AI agent with two tools: bash and io_wait.\n" +
  "- bash: execute shell commands. Use it for ALL external actions.\n" +
  "- io_wait: pause until the next external event. This is a TOOL CALL, not a shell command. " +
  "Never run io_wait via bash — invoke it directly as a tool.\n\n" +
  "User messages appear in environment reminders as [user@channel] lines.\n" +
  "To reply: bash tool → node dist/cli/main.js im send --channel <channel> --kind status --text '<reply>'\n" +
  "After replying or completing work: io_wait tool → wait for the next user message.\n\n" +
  "Workflow: read user message → bash(work) → bash(im send reply) → io_wait.\n" +
  "The tiny-agent CLI is available via `node dist/cli/main.js` (subcommands: im, skill).";

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export class PromptBuilder {
  /**
   * Build the initial prompt for a new run (no history yet).
   */
  buildInitialPrompt(task: string): ModelPrompt {
    const messages: ModelPromptMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: task },
    ];

    return { messages };
  }

  /**
   * Build a prompt that includes prior tool-call / observation history.
   */
  buildNextPrompt(task: string, history: HistoryEntry[]): ModelPrompt {
    const messages: ModelPromptMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: task },
    ];

    for (const entry of history) {
      if (entry.role === "assistant_tool_call") {
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            type: "tool_call",
            id: entry.toolCallId,
            name: entry.name,
            arguments: entry.arguments,
          }),
        });
      } else if (entry.role === "tool_result") {
        messages.push({
          role: "observation",
          content: JSON.stringify(entry.observation),
        });
      } else if (entry.role === "environment_reminder") {
        messages.push({
          role: "system",
          content: entry.content,
        });
      }
    }

    return { messages };
  }
}

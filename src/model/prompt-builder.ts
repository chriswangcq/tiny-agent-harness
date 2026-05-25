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
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE =
  "All external actions must use the provided tools. The only available tool is bash. Return final content when the task is complete. " +
  "The tiny-agent CLI is available in bash sessions via `npx tiny-agent` or `node dist/cli/main.js`. " +
  "Run `npx tiny-agent --help` for all subcommands including im (messaging) and skill (skill management).";

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
      } else {
        messages.push({
          role: "observation",
          content: JSON.stringify(entry.observation),
        });
      }
    }

    return { messages };
  }
}

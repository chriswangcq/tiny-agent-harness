import type {
  ModelPrompt,
  ChatMessage,
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
  "All external actions must use the provided tools. The only available tool is bash. Return final content when the task is complete.";

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export class PromptBuilder {
  /**
   * Build the initial prompt for a new run (no history yet).
   */
  buildInitialPrompt(task: string): ModelPrompt {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: task },
    ];

    return { messages };
  }

  /**
   * Build a prompt that includes prior tool-call / observation history.
   */
  buildNextPrompt(task: string, history: HistoryEntry[]): ModelPrompt {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: task },
    ];

    for (const entry of history) {
      if (entry.role === "assistant_tool_call") {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: entry.toolCallId,
              type: "function",
              function: {
                name: entry.name,
                arguments:
                  typeof entry.arguments === "string"
                    ? entry.arguments
                    : JSON.stringify(entry.arguments),
              },
            },
          ],
        });
      } else {
        // tool_result
        messages.push({
          role: "tool",
          tool_call_id: entry.toolCallId,
          content: JSON.stringify(entry.observation),
        });
      }
    }

    return { messages };
  }
}

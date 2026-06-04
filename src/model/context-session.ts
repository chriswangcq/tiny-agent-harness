import type {
  AgentThinking,
  InternalToolCall,
  V4ChatMessage,
} from "../types/model.js";
import type { IoWaitRequest } from "../types/environment.js";
import type { ToolObservation } from "../types/tools.js";
import {
  PromptBuilder,
  wrapReminderAsUserContent,
  type HistoryEntry,
} from "./prompt-builder.js";
import type {
  ModelContextCompactionResult,
  ModelContextWindowPort,
} from "./context-window.js";

export type ModelContextItemProvenance =
  | {
      kind: "runtime_effect";
      stepIndex: number;
    }
  | {
      kind: "transcript_replay";
      stepIndex: number;
      eventType: string;
      eventTimestamp: string;
    };

type ModelContextItemBase = {
  provenance?: ModelContextItemProvenance;
};

export type ModelContextItem =
  | ({
      type: "tool_call";
      toolCall: InternalToolCall;
      thinking?: AgentThinking;
    } & ModelContextItemBase)
  | ({
      type: "io_wait_call";
      toolCallId: string;
      wait: IoWaitRequest;
      thinking?: AgentThinking;
    } & ModelContextItemBase)
  | ({
      type: "observation";
      observation: ToolObservation;
      toolCallId?: string;
    } & ModelContextItemBase)
  | ({ type: "environment_reminder"; content: string } & ModelContextItemBase);

export type ModelContextSessionState = {
  task: string;
  items: ModelContextItem[];
};

export type ModelContextSessionSnapshot = {
  version: 1;
  task: string;
  items: ModelContextItem[];
};

export type ModelContextAppendResult = {
  appendedCount: number;
  itemCount: number;
};

export type ModelContextPrepareRequest = {
  transientReminders?: readonly string[];
};

export type ModelContextPrepareResult = {
  messages: V4ChatMessage[];
  itemCount: number;
};

export type ModelContextCompactRequest = {
  contextWindow?: ModelContextWindowPort;
  stepIndex: number;
};

export interface ModelContextSessionPort {
  append(
    itemOrItems: ModelContextItem | readonly ModelContextItem[],
  ): ModelContextAppendResult;
  prepareModelTurn(request?: ModelContextPrepareRequest): ModelContextPrepareResult;
  compactIfNeeded(
    request: ModelContextCompactRequest,
  ): Promise<ModelContextCompactionResult | undefined>;
  snapshot(): ModelContextSessionSnapshot;
}

export interface ModelContextRenderer {
  render(input: {
    task: string;
    items: readonly ModelContextItem[];
    transientReminders?: readonly string[];
  }): V4ChatMessage[];
}

export class PromptBuilderContextRenderer implements ModelContextRenderer {
  constructor(private readonly promptBuilder: PromptBuilder = new PromptBuilder()) {}

  render(input: {
    task: string;
    items: readonly ModelContextItem[];
    transientReminders?: readonly string[];
  }): V4ChatMessage[] {
    const history = modelContextItemsToHistoryEntries(input.items);
    const { messages } = this.promptBuilder.buildNextPrompt(input.task, history);

    for (const reminder of input.transientReminders ?? []) {
      messages.push({
        role: "user",
        content: wrapReminderAsUserContent(reminder),
      });
    }

    return messages;
  }
}

export class ModelContextSession implements ModelContextSessionPort {
  private state: ModelContextSessionState;

  constructor(
    private readonly renderer: ModelContextRenderer,
    state: ModelContextSessionState,
    private readonly contextWindow?: ModelContextWindowPort,
  ) {
    this.state = {
      task: state.task,
      items: [...state.items],
    };
  }

  static create(input: {
    task: string;
    renderer: ModelContextRenderer;
    contextWindow?: ModelContextWindowPort;
    initialItems?: readonly ModelContextItem[];
  }): ModelContextSession {
    return new ModelContextSession(
      input.renderer,
      {
        task: input.task,
        items: [...(input.initialItems ?? [])],
      },
      input.contextWindow,
    );
  }

  static restore(input: {
    snapshot: ModelContextSessionSnapshot;
    renderer: ModelContextRenderer;
    contextWindow?: ModelContextWindowPort;
  }): ModelContextSession {
    return new ModelContextSession(
      input.renderer,
      {
        task: input.snapshot.task,
        items: [...input.snapshot.items],
      },
      input.contextWindow,
    );
  }

  append(
    itemOrItems: ModelContextItem | readonly ModelContextItem[],
  ): ModelContextAppendResult {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    this.state = {
      ...this.state,
      items: [...this.state.items, ...items],
    };
    return {
      appendedCount: items.length,
      itemCount: this.state.items.length,
    };
  }

  prepareModelTurn(
    request: ModelContextPrepareRequest = {},
  ): ModelContextPrepareResult {
    return {
      messages: this.renderer.render({
        task: this.state.task,
        items: this.state.items,
        transientReminders: request.transientReminders,
      }),
      itemCount: this.state.items.length,
    };
  }

  async compactIfNeeded(
    request: ModelContextCompactRequest,
  ): Promise<ModelContextCompactionResult | undefined> {
    const contextWindow = request.contextWindow ?? this.contextWindow;
    if (contextWindow === undefined) {
      throw new Error("ModelContextSession compactIfNeeded requires contextWindow");
    }

    const tokenCount = contextWindow.countTokens(this.state.items);
    const maxTokens = contextWindow.maxTokens;
    if (tokenCount < maxTokens) {
      return undefined;
    }

    const compaction = contextWindow.compact({
      items: this.state.items,
      tokenCount,
      maxTokens,
      stepIndex: request.stepIndex,
    });
    if (compaction === undefined || compaction.droppedItemCount === 0) {
      return undefined;
    }

    let items = [...compaction.items];
    let summary = compaction.summary;
    if (contextWindow.llmEnrichSummary) {
      try {
        const enriched = await contextWindow.llmEnrichSummary(
          summary,
          this.state.items.slice(0, compaction.droppedItemCount),
        );
        if (enriched && !enriched.startsWith("[LLM")) {
          const firstItem = items[0];
          if (firstItem?.type === "environment_reminder") {
            items = [
              {
                ...firstItem,
                content: `${firstItem.content}${enriched}`,
              },
              ...items.slice(1),
            ];
            summary = `${summary}${enriched}`;
          }
        }
      } catch {
        /* LLM enrichment is best-effort and explicitly injected. */
      }
    }

    const finalCompaction = {
      ...compaction,
      items,
      summary,
    };
    this.state = {
      ...this.state,
      items,
    };
    return finalCompaction;
  }

  snapshot(): ModelContextSessionSnapshot {
    return {
      version: 1,
      task: this.state.task,
      items: [...this.state.items],
    };
  }
}

export function modelContextItemsToHistoryEntries(
  items: readonly ModelContextItem[],
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const item of items) {
    if (item.type === "tool_call") {
      entries.push({
        role: "assistant_tool_call",
        toolCallId: item.toolCall.id,
        name: item.toolCall.name,
        arguments: item.toolCall.arguments,
        thinking: item.thinking?.content,
      });
    } else if (item.type === "io_wait_call") {
      entries.push({
        role: "assistant_tool_call",
        toolCallId: item.toolCallId,
        name: "io_wait",
        arguments: item.wait,
        thinking: item.thinking?.content,
      });
    } else if (item.type === "observation") {
      entries.push({
        role: "tool_result",
        toolCallId: item.toolCallId ?? "",
        observation: item.observation,
      });
    } else if (item.type === "environment_reminder") {
      entries.push({
        role: "environment_reminder",
        content: item.content,
      });
    }
  }

  return entries;
}

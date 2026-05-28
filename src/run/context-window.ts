import type { HistoryItem } from "./orchestrator.js";

export const DEFAULT_CONTEXT_WINDOW_MAX_HISTORY_TOKENS = 700_000;
export const DEFAULT_CONTEXT_WINDOW_RECENT_ITEMS = 40;

export type HistoryCompactionResult = {
  history: HistoryItem[];
  summary: string;
  tokenCount: number;
  maxTokens: number;
  originalItemCount: number;
  retainedItemCount: number;
  droppedItemCount: number;
};

export type HistoryCompactionInput = {
  history: readonly HistoryItem[];
  tokenCount: number;
  maxTokens: number;
  stepIndex: number;
};

export interface ContextWindowPort {
  maxHistoryTokens: number;
  countHistoryTokens(history: readonly HistoryItem[]): number;
  compactHistory(input: HistoryCompactionInput): HistoryCompactionResult | undefined;
}

export type DeterministicHistoryCompactorOptions = {
  recentItemCount?: number;
  maxSummaryItems?: number;
  maxSummaryChars?: number;
};

export class DeterministicHistoryCompactor {
  private readonly recentItemCount: number;
  private readonly maxSummaryItems: number;
  private readonly maxSummaryChars: number;

  constructor(options: DeterministicHistoryCompactorOptions = {}) {
    this.recentItemCount =
      options.recentItemCount ?? DEFAULT_CONTEXT_WINDOW_RECENT_ITEMS;
    this.maxSummaryItems = options.maxSummaryItems ?? 24;
    this.maxSummaryChars = options.maxSummaryChars ?? 6000;
  }

  compact(input: HistoryCompactionInput): HistoryCompactionResult | undefined {
    const original = [...input.history];
    const retainedItemCount = Math.min(this.recentItemCount, original.length);
    const dropped = original.slice(0, original.length - retainedItemCount);
    if (dropped.length === 0) {
      return undefined;
    }

    const tail = original.slice(-retainedItemCount);
    const summary = this.buildSummary({
      dropped,
      retainedItemCount,
      tokenCount: input.tokenCount,
      maxTokens: input.maxTokens,
      stepIndex: input.stepIndex,
    });

    return {
      history: [{ type: "environment_reminder", content: summary }, ...tail],
      summary,
      tokenCount: input.tokenCount,
      maxTokens: input.maxTokens,
      originalItemCount: original.length,
      retainedItemCount,
      droppedItemCount: dropped.length,
    };
  }

  private buildSummary(input: {
    dropped: HistoryItem[];
    retainedItemCount: number;
    tokenCount: number;
    maxTokens: number;
    stepIndex: number;
  }): string {
    const lines = [
      "Compressed agent-loop history.",
      `Compression step: ${input.stepIndex}`,
      `History tokens before compression: ${input.tokenCount}/${input.maxTokens}`,
      `Dropped history items: ${input.dropped.length}`,
      `Recent history items retained verbatim: ${input.retainedItemCount}`,
      "",
      "Dropped history summary:",
    ];

    for (const [index, item] of input.dropped
      .slice(0, this.maxSummaryItems)
      .entries()) {
      lines.push(`- ${index + 1}. ${describeHistoryItem(item)}`);
    }
    if (input.dropped.length > this.maxSummaryItems) {
      lines.push(`- ... ${input.dropped.length - this.maxSummaryItems} more items`);
    }

    const summary = lines.join("\n");
    if (summary.length <= this.maxSummaryChars) {
      return summary;
    }
    return `${summary.slice(0, Math.max(0, this.maxSummaryChars - 1))}…`;
  }
}

function describeHistoryItem(item: HistoryItem): string {
  switch (item.type) {
    case "tool_call":
      return `assistant tool_call ${item.toolCall.name} id=${item.toolCall.id} args=${preview(JSON.stringify(item.toolCall.arguments), 180)}`;
    case "io_wait_call":
      return `assistant io_wait id=${item.toolCallId} reason=${preview(item.wait.reason ?? "", 120)} condition=${preview(JSON.stringify(item.wait.condition), 120)}`;
    case "observation":
      return `tool observation ${preview(JSON.stringify(item.observation), 220)}`;
    case "environment_reminder":
      return `environment reminder ${preview(item.content.replace(/\s+/gu, " "), 220)}`;
  }
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

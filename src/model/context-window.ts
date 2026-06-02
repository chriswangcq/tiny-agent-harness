import type { ModelContextItem } from "./context-session.js";

export const DEFAULT_CONTEXT_WINDOW_MAX_TOKENS = 700_000;
export const DEFAULT_CONTEXT_WINDOW_RECENT_ITEMS = 40;

export type ModelContextCompactionResult = {
  tokenCount: number;
  maxTokens: number;
  items: ModelContextItem[];
  summary: string;
  originalItemCount: number;
  retainedItemCount: number;
  droppedItemCount: number;
};

export type ModelContextCompactionInput = {
  items: ModelContextItem[];
  tokenCount: number;
  maxTokens: number;
  stepIndex: number;
};

export interface ModelContextWindowPort {
  countTokens(items: readonly ModelContextItem[]): number;
  maxTokens: number;
  compact(input: ModelContextCompactionInput): ModelContextCompactionResult | undefined;
  llmEnrichSummary?: (
    summary: string,
    droppedItems: readonly ModelContextItem[],
  ) => Promise<string>;
}

export class DeterministicModelContextCompactor implements ModelContextWindowPort {
  readonly maxTokens: number;
  private readonly retainedItemCount: number;
  private readonly maxSummaryItems: number;
  private readonly maxSummaryChars: number;
  private readonly groupSimilarToolCalls: boolean;
  private readonly now: () => string;

  constructor(options?: {
    maxTokens?: number;
    retainedItemCount?: number;
    recentItemCount?: number;
    maxSummaryItems?: number;
    maxSummaryChars?: number;
    groupSimilarToolCalls?: boolean;
    now?: () => string;
  }) {
    this.maxTokens =
      options?.maxTokens ?? DEFAULT_CONTEXT_WINDOW_MAX_TOKENS;
    this.retainedItemCount =
      options?.recentItemCount ?? options?.retainedItemCount ?? DEFAULT_CONTEXT_WINDOW_RECENT_ITEMS;
    this.maxSummaryItems = options?.maxSummaryItems ?? 500;
    this.maxSummaryChars = options?.maxSummaryChars ?? 12_000;
    this.groupSimilarToolCalls = options?.groupSimilarToolCalls ?? true;
    this.now = options?.now ?? (() => "not-provided");
  }

  countTokens(items: readonly ModelContextItem[]): number {
    let total = 0;
    for (const item of items) {
      const s = describeHistoryItemBrief(item);
      total += Math.ceil(s.length / 2.5);
    }
    return total;
  }

  compact(
    input: ModelContextCompactionInput,
  ): ModelContextCompactionResult | undefined {
    if (input.items.length <= this.retainedItemCount) {
      return undefined;
    }

    const keepCount = Math.max(1, this.retainedItemCount);
    const dropCount = input.items.length - keepCount;
    const retained = input.items.slice(-keepCount);
    const dropped = input.items.slice(0, dropCount);

    const summary = this.buildSummary({
      dropped,
      retainedItemCount: retained.length,
      tokenCount: input.tokenCount,
      maxTokens: input.maxTokens,
      stepIndex: input.stepIndex,
    });

    const compactedItems: ModelContextItem[] = [
      {
        type: "environment_reminder",
        content: summary,
      },
      ...retained,
    ];

    return {
      tokenCount: input.tokenCount,
      maxTokens: input.maxTokens,
      items: compactedItems,
      summary,
      originalItemCount: input.items.length,
      retainedItemCount: retained.length,
      droppedItemCount: dropped.length,
    };
  }

  private buildSummary(input: {
    dropped: ModelContextItem[];
    retainedItemCount: number;
    tokenCount: number;
    maxTokens: number;
    stepIndex: number;
  }): string {
    const now = this.now();

    // Phase 1: Coalesce similar tool calls
    const coalesced = this.groupSimilarToolCalls
      ? coalesceItems(input.dropped)
      : input.dropped;

    const lines = [
      "Compressed model-context history.",
      `Compression step: ${input.stepIndex}`,
      `Compression timestamp: ${now}`,
      `History tokens before compression: ${input.tokenCount}/${input.maxTokens}`,
      `Dropped history items: ${input.dropped.length} (coalesced to ${coalesced.length})`,
      `Recent history items retained verbatim: ${input.retainedItemCount}`,
      "",
    ];

    // Phase 1: Category-based grouping
    const categorized = groupByCategory(coalesced);
    const catOrder = ["User Messages", "Assistant Actions", "Tool Observations"] as const;

    for (const cat of catOrder) {
      const items = categorized[cat];
      if (items.length === 0) continue;
      lines.push(`${cat}:`);
      for (const [i, item] of items.slice(0, this.maxSummaryItems).entries()) {
        lines.push(`  ${i + 1}. ${describeHistoryItemExtended(item)}`);
      }
      if (items.length > this.maxSummaryItems) {
        lines.push(`  ... ${items.length - this.maxSummaryItems} more items`);
      }
    }

    // Phase 1: Task progress summary
    const progress = detectProgress(input.dropped);
    if (progress) {
      lines.push("");
      lines.push(`Task Progress: ${progress}`);
    }

    const summary = lines.join("\n");
    if (summary.length <= this.maxSummaryChars) {
      return summary;
    }
    return `${summary.slice(0, Math.max(0, this.maxSummaryChars - 1))}…`;
  }
}

// ─── Phase 1: Enhanced Description ──────────────────────────────────

function describeHistoryItemBrief(item: ModelContextItem): string {
  switch (item.type) {
    case "tool_call":
      return `tool_call:${(item as { toolCall: { name: string } }).toolCall.name}`;
    case "io_wait_call":
      return `io_wait:${item.wait.reason ?? "wait"}`;
    case "observation":
      return `observation`;
    case "environment_reminder":
      return `env:${item.content.slice(0, 60)}`;
  }
}

function describeHistoryItemExtended(item: ModelContextItem): string {
  switch (item.type) {
    case "tool_call": {
      const args = summarizeArgs((item as { toolCall: { arguments: Record<string, unknown> } }).toolCall.arguments);
      return `tool_call ${(item as { toolCall: { name: string } }).toolCall.name} ${args}`;
    }
    case "io_wait_call": {
      const reason = item.wait.reason ?? "wait";
      const minLevel = item.wait.minLevel ?? item.wait.condition?.minLevel ?? 0;
      return `io_wait reason=${preview(reason, 60)} minLevel=${minLevel}`;
    }
    case "observation": {
      const obs = item.observation as Record<string, unknown> | undefined;
      if (obs && typeof obs === "object") {
        const parts: string[] = [];
        if (obs.returnedToPrompt === true) parts.push("returned");
        if (typeof obs.eventCount === "number") parts.push(`${obs.eventCount} events`);
        const term = obs.terminal as Record<string, unknown> | undefined;
        if (term?.foregroundProcess) parts.push(`fg:${term.foregroundProcess}`);
        return `observation${parts.length > 0 ? ` [${parts.join(", ")}]` : ""}`;
      }
      return `observation`;
    }
    case "environment_reminder": {
      const msgs = extractUserMessages(item.content);
      if (msgs.length > 0) {
        return `env reminder [user: ${msgs.slice(0, 3).join(" | ")}]`;
      }
      return `env reminder ${preview(item.content.replace(/\s+/gu, " "), 100)}`;
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const kv: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      kv.push(`${k}=${preview(v, 30)}`);
    } else if (typeof v === "object") {
      kv.push(`${k}=${preview(JSON.stringify(v), 40)}`);
    } else {
      kv.push(`${k}=${v}`);
    }
  }
  return kv.slice(0, 5).join(" ");
}

// ─── Phase 1: Category Grouping ─────────────────────────────────────

type Category = "User Messages" | "Assistant Actions" | "Tool Observations";

function groupByCategory(items: ModelContextItem[]): Record<Category, ModelContextItem[]> {
  const result: Record<Category, ModelContextItem[]> = {
    "User Messages": [],
    "Assistant Actions": [],
    "Tool Observations": [],
  };

  for (const item of items) {
    if (item.type === "environment_reminder") {
      const msgs = extractUserMessages(item.content);
      if (msgs.length > 0) {
        result["User Messages"].push(item);
      } else {
        // Skip system env reminders in categorized view
        continue;
      }
    } else if (item.type === "tool_call" || item.type === "io_wait_call") {
      result["Assistant Actions"].push(item);
    } else if (item.type === "observation") {
      result["Tool Observations"].push(item);
    }
  }

  return result;
}

// ─── Phase 1: Coalescing ────────────────────────────────────────────

function coalesceItems(items: ModelContextItem[]): ModelContextItem[] {
  const result: ModelContextItem[] = [];
  let i = 0;

  while (i < items.length) {
    const current = items[i];

    if (current.type === "tool_call") {
      let same = 1;
      while (
        i + same < items.length &&
        items[i + same].type === "tool_call" &&
        items[i + same].type === "tool_call" && (items[i + same] as { toolCall: { name: string } }).toolCall.name === (current as { toolCall: { name: string } }).toolCall.name
      ) {
        same++;
      }
      if (same > 1) {
        result.push(current); // representative
        i += same;
        continue;
      }
    }
    result.push(current);
    i++;
  }

  return result;
}

// ─── Phase 1: Progress Detection ────────────────────────────────────

function detectProgress(items: ModelContextItem[]): string {
  const tools = new Map<string, number>();
  const userMsgs: string[] = [];

  for (const item of items) {
    if (item.type === "tool_call") {
      tools.set((item as { toolCall: { name: string } }).toolCall.name, (tools.get((item as { toolCall: { name: string } }).toolCall.name) ?? 0) + 1);
    }
    if (item.type === "environment_reminder") {
      userMsgs.push(...extractUserMessages(item.content));
    }
  }

  const parts: string[] = [];
  if (tools.size > 0) {
    const top = [...tools.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([n, c]) => `${n}(${c})`)
      .join(", ");
    parts.push(`Tools: ${top}`);
  }
  if (userMsgs.length > 0) {
    parts.push(`${userMsgs.length} user messages`);
  }

  return parts.length > 0 ? parts.join(" | ") : "";
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractUserMessages(content: string): string[] {
  const re = /\[user@([^\]]+)\]\s*(.+?)(?=\n|$)/g;
  const msgs: string[] = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    msgs.push(m[2].trim().slice(0, 80));
  }
  return msgs;
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

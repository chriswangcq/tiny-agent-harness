import type { HistoryItem } from "./orchestrator.js";

export const DEFAULT_CONTEXT_WINDOW_MAX_HISTORY_TOKENS = 700_000;
export const DEFAULT_CONTEXT_WINDOW_RECENT_ITEMS = 40;

export type HistoryCompactionResult = {
  tokenCount: number;
  maxTokens: number;
  history: HistoryItem[];
  summary: string;
  originalItemCount: number;
  retainedItemCount: number;
  droppedItemCount: number;
};

export type HistoryCompactionInput = {
  history: HistoryItem[];
  tokenCount: number;
  maxTokens: number;
  stepIndex: number;
};

export interface ContextWindowPort {
  countHistoryTokens(history: HistoryItem[]): number;
  maxHistoryTokens: number;
  compactHistory(input: HistoryCompactionInput): HistoryCompactionResult | undefined;
}

export class DeterministicHistoryCompactor implements ContextWindowPort {
  readonly maxHistoryTokens: number;
  private readonly retainedItemCount: number;
  private readonly maxSummaryItems: number;
  private readonly maxSummaryChars: number;
  private readonly groupSimilarToolCalls: boolean;
  private readonly llmSummarize?: (items: HistoryItem[]) => Promise<string>;

  constructor(options?: {
    maxHistoryTokens?: number;
    retainedItemCount?: number;
    maxSummaryItems?: number;
    maxSummaryChars?: number;
    groupSimilarToolCalls?: boolean;
    llmSummarize?: (items: HistoryItem[]) => Promise<string>;
  }) {
    this.maxHistoryTokens =
      options?.maxHistoryTokens ?? DEFAULT_CONTEXT_WINDOW_MAX_HISTORY_TOKENS;
    this.retainedItemCount =
      options?.retainedItemCount ?? DEFAULT_CONTEXT_WINDOW_RECENT_ITEMS;
    this.maxSummaryItems = options?.maxSummaryItems ?? 500;
    this.maxSummaryChars = options?.maxSummaryChars ?? 12_000;
    this.groupSimilarToolCalls = options?.groupSimilarToolCalls ?? true;
    this.llmSummarize = options?.llmSummarize;
  }

  countHistoryTokens(_history: HistoryItem[]): number {
    let total = 0;
    for (const item of _history) {
      const s = describeHistoryItemBrief(item);
      total += Math.ceil(s.length / 2.5);
    }
    return total;
  }

  compactHistory(
    input: HistoryCompactionInput,
  ): HistoryCompactionResult | undefined {
    return this.compact(input);
  }

  compact(input: HistoryCompactionInput): HistoryCompactionResult | undefined {
    if (input.history.length <= this.retainedItemCount) {
      return undefined;
    }

    const keepCount = Math.max(1, this.retainedItemCount);
    const dropCount = input.history.length - keepCount;
    const retained = input.history.slice(-keepCount);
    const dropped = input.history.slice(0, dropCount);

    const summary = this.buildSummary({
      dropped,
      retainedItemCount: retained.length,
      tokenCount: input.tokenCount,
      maxTokens: input.maxTokens,
      stepIndex: input.stepIndex,
    });

    const compactedHistory: HistoryItem[] = [
      {
        type: "environment_reminder",
        content: summary,
      },
      ...retained,
    ];

    return {
      tokenCount: input.tokenCount,
      maxTokens: input.maxTokens,
      history: compactedHistory,
      summary,
      originalItemCount: input.history.length,
      retainedItemCount: retained.length,
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
    const now = new Date().toISOString();

    // Phase 1: Coalesce similar tool calls
    const coalesced = this.groupSimilarToolCalls
      ? coalesceItems(input.dropped)
      : input.dropped;

    const lines = [
      "Compressed agent-loop history.",
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

function describeHistoryItemBrief(item: HistoryItem): string {
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

function describeHistoryItemExtended(item: HistoryItem): string {
  switch (item.type) {
    case "tool_call": {
      const args = summarizeArgs((item as { toolCall: { arguments: Record<string, unknown> } }).toolCall.arguments);
      return `tool_call ${(item as { toolCall: { name: string } }).toolCall.name} ${args}`;
    }
    case "io_wait_call": {
      const reason = item.wait.reason ?? "wait";
      const cond = item.wait.condition
        ? typeof item.wait.condition === "object"
          ? `kind=${(item.wait.condition as { kind?: string }).kind ?? ""}`
          : ""
        : "";
      return `io_wait reason=${preview(reason, 60)} ${cond}`;
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

function groupByCategory(items: HistoryItem[]): Record<Category, HistoryItem[]> {
  const result: Record<Category, HistoryItem[]> = {
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

function coalesceItems(items: HistoryItem[]): HistoryItem[] {
  const result: HistoryItem[] = [];
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

function detectProgress(items: HistoryItem[]): string {
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

// Keep original function for backward compatibility
function describeHistoryItem(item: HistoryItem): string {
  return describeHistoryItemExtended(item);
}

// ─── Phase 2: LLM Semantic Summary ────────────────────────────────

export interface LlmSummaryConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Generate a semantic summary of dropped history items by calling DeepSeek API.
 * Used externally and the result is injected into the summary.
 */
export async function generateLlmHistorySummary(
  items: HistoryItem[],
  config: LlmSummaryConfig,
): Promise<string> {
  const baseUrl = config.baseUrl ?? "https://api.deepseek.com";
  const model = config.model ?? "deepseek-chat";

  const itemsText = items
    .map((item, i) => {
      const desc = describeHistoryItemBrief(item);
      return `[${i}] ${item.type}: ${desc}`;
    })
    .join("\n");

  const prompt = `You are summarizing agent conversation history for context compression.
Below are items that are being removed from the context window.
Generate a concise but informative summary (max 500 words) that preserves:

1. What the user asked for (task goals)
2. What was accomplished (completed steps, key decisions)
3. What's in progress (ongoing work)
4. Any errors or issues encountered
5. Key tool/command patterns used

Summarize in Chinese if the conversation was in Chinese.
Keep the summary structured and factual.

Items being dropped:
${itemsText.slice(0, 8000)}

Summary:`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: prompt },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      return `[LLM summary failed: HTTP ${response.status}]`;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (summary) {
      return `\n[LLM Semantic Summary]\n${summary}\n`;
    }
    return `[LLM summary empty]`;
  } catch (err) {
    return `[LLM summary error: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

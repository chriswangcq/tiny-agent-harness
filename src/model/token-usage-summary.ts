/**
 * Token usage summary helper.
 *
 * Takes an array of RunEvent objects and extracts model_usage_recorded events
 * to produce a compact aggregated summary with thinking vs decision separation,
 * cache hit/miss fields, and stepIndex / decisionId correlation.
 *
 * This module is a pure function with no side effects, no globals, and no
 * hidden state. Every input is explicit.
 */

import type { RunEvent } from "../types/run.js";
import type { NormalizedProviderUsage } from "./token-usage-normalizer.js";

// ─── Public types ───────────────────────────────────────────────────────

/** Aggregated usage for a single FIM pass (thinking or decision). */
export interface AggregatedPassUsage {
  /** Sum of prompt_tokens (snake_case preferred) across all provider chunks. */
  totalPromptTokens: number;
  /** Sum of prompt_cache_hit_tokens (snake_case preferred) across all chunks. */
  totalCacheHitTokens: number;
  /** Sum of prompt_cache_miss_tokens (snake_case preferred) across all chunks. */
  totalCacheMissTokens: number;
  /** Sum of completion_tokens (snake_case preferred) across all chunks. */
  totalCompletionTokens: number;
  /** Sum of total_tokens (snake_case preferred) across all chunks. */
  totalTokens: number;
  /** Finish reasons collected across all events + continuation rounds. */
  finishReasons: Array<string | null | undefined>;
  /** Total continuation rounds summed across all events. */
  continuationRounds: number;
  /** Number of provider-level usage objects processed. */
  providerChunks: number;
}

/** The top-level summary produced from model_usage_recorded events. */
export interface TokenUsageSummary {
  /** Number of model_usage_recorded events found. */
  eventCount: number;
  /** Step indexes represented in the events. */
  stepIndexes: number[];
  /** Decision IDs from the events. */
  decisionIds: string[];
  /** Aggregated thinking pass usage. */
  thinking: AggregatedPassUsage;
  /** Aggregated decision pass usage. */
  decision: AggregatedPassUsage;
}

// ─── Internal helpers ───────────────────────────────────────────────────

function emptyPassUsage(): AggregatedPassUsage {
  return {
    totalPromptTokens: 0,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    finishReasons: [],
    continuationRounds: 0,
    providerChunks: 0,
  };
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return 0;
}

function tokenVal(
  snake: unknown,
  camel: unknown,
): number {
  // Snake_case wins when present (typeof number, finite), even for 0.
  if (typeof snake === "number" && Number.isFinite(snake)) {
    return Math.max(0, Math.floor(snake));
  }
  return numberOrZero(camel);
}

function aggregateProviderUsage(
  acc: AggregatedPassUsage,
  usage: NormalizedProviderUsage,
): void {
  acc.totalPromptTokens += tokenVal(usage.prompt_tokens, usage.promptTokens);
  acc.totalCacheHitTokens += tokenVal(
    usage.prompt_cache_hit_tokens,
    usage.promptCacheHitTokens,
  );
  acc.totalCacheMissTokens += tokenVal(
    usage.prompt_cache_miss_tokens,
    usage.promptCacheMissTokens,
  );
  acc.totalCompletionTokens += tokenVal(
    usage.completion_tokens,
    usage.completionTokens,
  );
  acc.totalTokens += tokenVal(usage.total_tokens, usage.totalTokens);

  acc.providerChunks += 1;
}

function aggregatePass(
  acc: AggregatedPassUsage,
  pass: { finishReasons?: unknown; continuationRounds?: unknown; usages?: unknown },
): void {
  // finishReasons
  if (Array.isArray(pass.finishReasons)) {
    for (const r of pass.finishReasons) {
      acc.finishReasons.push(r);
    }
  }

  // continuationRounds
  const rounds = numberOrZero(pass.continuationRounds);
  acc.continuationRounds += rounds;

  // usages
  if (Array.isArray(pass.usages)) {
    for (const u of pass.usages) {
      if (u != null && typeof u === "object" && !Array.isArray(u)) {
        aggregateProviderUsage(acc, u as NormalizedProviderUsage);
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Summarize token usage from RunEvent objects.
 *
 * Only `model_usage_recorded` events are processed. All other event types
 * are silently ignored. If no matching events are found, returns a summary
 * with zero counts and empty arrays.
 *
 * @param events - An array of RunEvent objects (usually from transcript).
 * @returns A TokenUsageSummary with aggregated thinking and decision data.
 */
export function summarizeTokenUsage(events: RunEvent[]): TokenUsageSummary {
  const stepIndexes: number[] = [];
  const decisionIds: string[] = [];
  const thinking = emptyPassUsage();
  const decision = emptyPassUsage();

  for (const event of events) {
    if (event.type !== "model_usage_recorded") continue;

    stepIndexes.push(event.stepIndex);
    decisionIds.push(event.decisionId);

    // Aggregate thinking pass
    if (event.usage.thinking) {
      aggregatePass(thinking, event.usage.thinking);
    }

    // Aggregate decision pass
    if (event.usage.decision) {
      aggregatePass(decision, event.usage.decision);
    }
  }

  return {
    eventCount: stepIndexes.length,
    stepIndexes,
    decisionIds,
    thinking,
    decision,
  };
}

/**
 * Token usage consumer: a pure helper/view-model slice.
 *
 * Reads `RunEvent[]` (from transcript JSONL), calls `summarizeTokenUsage`,
 * and returns a compact display model suitable for TUI/debugger display.
 *
 * This module has no side effects, no globals, no file I/O, and no
 * hidden state. Every input is explicit.
 *
 * Boundary:
 * - Reads only `model_usage_recorded` events.
 * - Does NOT read raw prompt files, debug payloads, PTY screen text,
 *   display-redacted strings, session logs, provider responses, or
 *   cost/pricing policy.
 * - No pricing, no billing, no dashboard.
 */

import type { RunEvent } from "../types/run.js";
import { summarizeTokenUsage } from "../model/token-usage-summary.js";
import type { TokenUsageSummary } from "../model/token-usage-summary.js";

// --- Public types ---

/**
 * Compact display model for token usage.
 *
 * Derived from `RunEvent[]` via `summarizeTokenUsage`, with pre-computed
 * combined totals and short display lines.
 */
export interface TokenUsageView {
  /** Number of model_usage_recorded events processed. */
  eventCount: number;
  /** Step indexes represented. */
  stepIndexes: number[];
  /** True when no model_usage_recorded events were found. */
  isEmpty: boolean;

  // thinking pass totals
  thinkingPromptTokens: number;
  thinkingCompletionTokens: number;
  thinkingTotalTokens: number;
  thinkingCacheHitTokens: number;
  thinkingCacheMissTokens: number;

  // decision pass totals
  decisionPromptTokens: number;
  decisionCompletionTokens: number;
  decisionTotalTokens: number;
  decisionCacheHitTokens: number;
  decisionCacheMissTokens: number;

  // combined totals (thinking + decision)
  combinedPromptTokens: number;
  combinedCompletionTokens: number;
  combinedCacheHitTokens: number;
  combinedCacheMissTokens: number;
  combinedTotalTokens: number;

  /**
   * Short display lines suitable for TUI header / debugger display.
   * Empty when no usage events are present.
   */
  shortLines: string[];
}

// --- Public API ---

/**
 * Build a compact token usage display model from run events.
 *
 * @param events - An array of RunEvent objects (usually from transcript).
 * @returns A TokenUsageView with aggregated totals and short display lines.
 */
export function buildTokenUsageView(events: RunEvent[]): TokenUsageView {
  const summary = summarizeTokenUsage(events);

  const thinkingPrompt = summary.thinking.totalPromptTokens;
  const thinkingCompletion = summary.thinking.totalCompletionTokens;
  const thinkingTotal = summary.thinking.totalTokens;
  const thinkingCacheHit = summary.thinking.totalCacheHitTokens;
  const thinkingCacheMiss = summary.thinking.totalCacheMissTokens;

  const decisionPrompt = summary.decision.totalPromptTokens;
  const decisionCompletion = summary.decision.totalCompletionTokens;
  const decisionTotal = summary.decision.totalTokens;
  const decisionCacheHit = summary.decision.totalCacheHitTokens;
  const decisionCacheMiss = summary.decision.totalCacheMissTokens;

  const combinedPrompt = thinkingPrompt + decisionPrompt;
  const combinedCompletion = thinkingCompletion + decisionCompletion;
  const combinedCacheHit = thinkingCacheHit + decisionCacheHit;
  const combinedCacheMiss = thinkingCacheMiss + decisionCacheMiss;
  const combinedTotal = thinkingTotal + decisionTotal;

  const isEmpty = summary.eventCount === 0;

  const shortLines = isEmpty ? [] : buildShortLines(summary, {
    thinkingPrompt, thinkingCompletion, thinkingTotal, thinkingCacheHit,
    decisionPrompt, decisionCompletion, decisionTotal, decisionCacheHit,
    combinedPrompt, combinedCompletion, combinedTotal, combinedCacheHit,
  });

  return {
    eventCount: summary.eventCount,
    stepIndexes: summary.stepIndexes,
    isEmpty,

    thinkingPromptTokens: thinkingPrompt,
    thinkingCompletionTokens: thinkingCompletion,
    thinkingTotalTokens: thinkingTotal,
    thinkingCacheHitTokens: thinkingCacheHit,
    thinkingCacheMissTokens: thinkingCacheMiss,

    decisionPromptTokens: decisionPrompt,
    decisionCompletionTokens: decisionCompletion,
    decisionTotalTokens: decisionTotal,
    decisionCacheHitTokens: decisionCacheHit,
    decisionCacheMissTokens: decisionCacheMiss,

    combinedPromptTokens: combinedPrompt,
    combinedCompletionTokens: combinedCompletion,
    combinedCacheHitTokens: combinedCacheHit,
    combinedCacheMissTokens: combinedCacheMiss,
    combinedTotalTokens: combinedTotal,

    shortLines,
  };
}

// --- Internal helpers ---

interface FlatTotals {
  thinkingPrompt: number;
  thinkingCompletion: number;
  thinkingTotal: number;
  thinkingCacheHit: number;
  decisionPrompt: number;
  decisionCompletion: number;
  decisionTotal: number;
  decisionCacheHit: number;
  combinedPrompt: number;
  combinedCompletion: number;
  combinedTotal: number;
  combinedCacheHit: number;
}

function buildShortLines(
  summary: TokenUsageSummary,
  t: FlatTotals,
): string[] {
  const lines: string[] = [];

  // Combined total line
  const cacheInfo =
    t.combinedCacheHit > 0 ? ` (cache hit ${formatTokens(t.combinedCacheHit)})` : "";
  lines.push(
    `token usage: ${formatTokens(t.combinedTotal)} total` +
    ` (${summary.eventCount} events, steps ${formatStepRange(summary.stepIndexes)})` +
    cacheInfo,
  );

  // Thinking pass
  if (t.thinkingTotal > 0) {
    lines.push(
      `  think: ${formatTokens(t.thinkingTotal)}` +
      ` (prompt ${formatTokens(t.thinkingPrompt)}, comp ${formatTokens(t.thinkingCompletion)}` +
      (t.thinkingCacheHit > 0 ? `, cache hit ${formatTokens(t.thinkingCacheHit)}` : "") +
      `)`,
    );
  }

  // Decision pass
  if (t.decisionTotal > 0) {
    lines.push(
      `  dec:   ${formatTokens(t.decisionTotal)}` +
      ` (prompt ${formatTokens(t.decisionPrompt)}, comp ${formatTokens(t.decisionCompletion)}` +
      (t.decisionCacheHit > 0 ? `, cache hit ${formatTokens(t.decisionCacheHit)}` : "") +
      `)`,
    );
  }

  // Combined breakdown
  if (t.combinedTotal > 0 && (t.thinkingTotal > 0 || t.decisionTotal > 0)) {
    lines.push(
      `  combined: prompt ${formatTokens(t.combinedPrompt)},` +
      ` comp ${formatTokens(t.combinedCompletion)}`,
    );
  }

  return lines;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatStepRange(indexes: number[]): string {
  if (indexes.length === 0) return "-";
  const min = Math.min(...indexes);
  const max = Math.max(...indexes);
  if (min === max) return String(min);
  return `${min}-${max}`;
}

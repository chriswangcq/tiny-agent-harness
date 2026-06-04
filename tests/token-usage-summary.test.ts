import { describe, expect, it } from "vitest";
import {
  summarizeTokenUsage,
  type TokenUsageSummary,
  type AggregatedPassUsage,
} from "../src/model/token-usage-summary.js";
import type { RunEvent } from "../src/types/run.js";
import type { NormalizedFimUsage } from "../src/model/token-usage-normalizer.js";

// ---------------------------------------------------------------------------
// Helpers to build test events
// ---------------------------------------------------------------------------

function makeUsageEvent(
  stepIndex: number,
  decisionId: string,
  usage: NormalizedFimUsage,
  overrides?: Partial<Extract<RunEvent, { type: "model_usage_recorded" }>>,
): Extract<RunEvent, { type: "model_usage_recorded" }> {
  return {
    type: "model_usage_recorded",
    stepIndex,
    decisionId,
    usage,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("summarizeTokenUsage", () => {
  // ── missing usage ──

  it("returns empty summary for empty events array", () => {
    const result = summarizeTokenUsage([]);
    expect(result.eventCount).toBe(0);
    expect(result.stepIndexes).toEqual([]);
    expect(result.decisionIds).toEqual([]);
    expect(result.thinking.totalPromptTokens).toBe(0);
    expect(result.thinking.totalCompletionTokens).toBe(0);
    expect(result.thinking.totalTokens).toBe(0);
    expect(result.thinking.providerChunks).toBe(0);
    expect(result.decision.totalPromptTokens).toBe(0);
  });

  it("returns empty summary when no model_usage_recorded events are present", () => {
    const events: RunEvent[] = [
      {
        type: "run_started",
        runId: "r1",
        task: "test",
        cwd: "/tmp",
        timestamp: new Date().toISOString(),
      },
      {
        type: "model_requested",
        stepIndex: 0,
        timestamp: new Date().toISOString(),
      },
    ];
    const result = summarizeTokenUsage(events);
    expect(result.eventCount).toBe(0);
  });

  // ── partial usage (thinking only, decision only) ──

  it("aggregates thinking-only usage when decision is missing", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(1, "d1", usage)];

    const result = summarizeTokenUsage(events);
    expect(result.eventCount).toBe(1);
    expect(result.thinking.totalPromptTokens).toBe(100);
    expect(result.thinking.totalCompletionTokens).toBe(50);
    expect(result.thinking.totalTokens).toBe(150);
    expect(result.thinking.providerChunks).toBe(1);
    expect(result.decision.totalPromptTokens).toBe(0);
    expect(result.decision.totalTokens).toBe(0);
    expect(result.decision.providerChunks).toBe(0);
  });

  it("aggregates decision-only usage when thinking has no usages", () => {
    const usage: NormalizedFimUsage = {
      thinking: { finishReasons: ["stop"], continuationRounds: 0 },
      decision: {
        finishReasons: ["length"],
        continuationRounds: 1,
        usages: [{ prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 }],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d0", usage)];

    const result = summarizeTokenUsage(events);
    expect(result.thinking.totalPromptTokens).toBe(0);
    expect(result.thinking.providerChunks).toBe(0);
    expect(result.decision.totalPromptTokens).toBe(200);
    expect(result.decision.totalCompletionTokens).toBe(10);
    expect(result.decision.totalTokens).toBe(210);
    expect(result.decision.providerChunks).toBe(1);
    expect(result.decision.finishReasons).toEqual(["length"]);
    expect(result.decision.continuationRounds).toBe(1);
  });

  // ── multiple provider usage chunks ──

  it("aggregates multiple usage chunks within a single event", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 100, completion_tokens: 50 },
          { prompt_tokens: 200, completion_tokens: 30 },
        ],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 300, completion_tokens: 10 },
          { prompt_tokens: 400, completion_tokens: 5 },
        ],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-chunk", usage)];

    const result = summarizeTokenUsage(events);
    expect(result.thinking.totalPromptTokens).toBe(300); // 100 + 200
    expect(result.thinking.totalCompletionTokens).toBe(80); // 50 + 30
    expect(result.thinking.providerChunks).toBe(2);
    expect(result.decision.totalPromptTokens).toBe(700); // 300 + 400
    expect(result.decision.totalCompletionTokens).toBe(15); // 10 + 5
    expect(result.decision.providerChunks).toBe(2);
  });

  // ── cache hit/miss fields ──

  it("aggregates cache hit/miss tokens (snake_case preferred)", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 1000,
            prompt_cache_hit_tokens: 800,
            prompt_cache_miss_tokens: 200,
            completion_tokens: 50,
            total_tokens: 1050,
          },
        ],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            promptTokens: 1200,
            promptCacheHitTokens: 900,
            promptCacheMissTokens: 300,
            completionTokens: 10,
            totalTokens: 1210,
          },
        ],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-cache", usage)];

    const result = summarizeTokenUsage(events);

    // thinking (snake_case)
    expect(result.thinking.totalPromptTokens).toBe(1000);
    expect(result.thinking.totalCacheHitTokens).toBe(800);
    expect(result.thinking.totalCacheMissTokens).toBe(200);
    expect(result.thinking.totalCompletionTokens).toBe(50);
    expect(result.thinking.totalTokens).toBe(1050);

    // decision (camelCase - used as fallback since no snake_case)
    expect(result.decision.totalPromptTokens).toBe(1200);
    expect(result.decision.totalCacheHitTokens).toBe(900);
    expect(result.decision.totalCacheMissTokens).toBe(300);
    expect(result.decision.totalCompletionTokens).toBe(10);
    expect(result.decision.totalTokens).toBe(1210);
  });

  it("prefers snake_case over camelCase when both present; does not double-count", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 100,
            promptTokens: 50,
            prompt_cache_hit_tokens: 80,
            promptCacheHitTokens: 20,
            completion_tokens: 5,
            completionTokens: 3,
            total_tokens: 105,
            totalTokens: 53,
          },
        ],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-both", usage)];

    const result = summarizeTokenUsage(events);
    // snake_case wins; camelCase is fallback, not additive
    expect(result.thinking.totalPromptTokens).toBe(100); // snake_case preferred
    expect(result.thinking.totalCacheHitTokens).toBe(80); // snake_case preferred
    expect(result.thinking.totalCompletionTokens).toBe(5); // snake_case preferred
    expect(result.thinking.totalTokens).toBe(105); // snake_case preferred
  });

  it("prefers explicit snake_case zero over nonzero camelCase", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 0,
            promptTokens: 50,
            prompt_cache_hit_tokens: 0,
            promptCacheHitTokens: 30,
            completion_tokens: 0,
            completionTokens: 10,
            total_tokens: 0,
            totalTokens: 100,
          },
        ],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-zero-snake", usage)];

    const result = summarizeTokenUsage(events);
    // snake_case is explicitly 0 — it wins over nonzero camelCase
    expect(result.thinking.totalPromptTokens).toBe(0);
    expect(result.thinking.totalCacheHitTokens).toBe(0);
    expect(result.thinking.totalCompletionTokens).toBe(0);
    expect(result.thinking.totalTokens).toBe(0);
  });
  // ── thinking vs decision separation ──

  it("preserves thinking vs decision separation when both passes have usage", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }],
      },
      decision: {
        finishReasons: ["stop", "length"],
        continuationRounds: 2,
        usages: [{ prompt_tokens: 300, completion_tokens: 30, total_tokens: 330 }],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(3, "d-sep", usage)];

    const result = summarizeTokenUsage(events);
    // thinking
    expect(result.thinking.totalPromptTokens).toBe(100);
    expect(result.thinking.totalCompletionTokens).toBe(50);
    expect(result.thinking.totalTokens).toBe(150);
    expect(result.thinking.finishReasons).toEqual(["stop"]);
    expect(result.thinking.continuationRounds).toBe(0);
    expect(result.thinking.providerChunks).toBe(1);

    // decision
    expect(result.decision.totalPromptTokens).toBe(300);
    expect(result.decision.totalCompletionTokens).toBe(30);
    expect(result.decision.totalTokens).toBe(330);
    expect(result.decision.finishReasons).toEqual(["stop", "length"]);
    expect(result.decision.continuationRounds).toBe(2);
    expect(result.decision.providerChunks).toBe(1);
  });

  // ── unknown provider fields ignored safely ──

  it("ignores unknown provider fields safely and preserves known ones", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 100,
            completion_tokens: 5,
            unknown_vendor: { nested: true },
            custom_flag: "experimental",
            _internal: 42,
          } as any,
        ],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-unknown", usage)];

    // Does not crash on unknown fields; known fields still work
    const result = summarizeTokenUsage(events);
    expect(result.thinking.totalPromptTokens).toBe(100);
    expect(result.thinking.totalCompletionTokens).toBe(5);
    expect(result.thinking.providerChunks).toBe(1);
  });

  // ── multiple model_usage_recorded events ──

  it("aggregates across multiple model_usage_recorded events", () => {
    const usage1: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [{ prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 }],
      },
    };
    const usage2: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["length"],
        continuationRounds: 1,
        usages: [{ prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 }],
      },
      decision: {
        finishReasons: ["length"],
        continuationRounds: 1,
        usages: [{ prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 }],
      },
    };

    const events: RunEvent[] = [
      makeUsageEvent(0, "d-event-0", usage1),
      makeUsageEvent(1, "d-event-1", usage2),
    ];

    const result = summarizeTokenUsage(events);

    expect(result.eventCount).toBe(2);
    expect(result.stepIndexes).toEqual([0, 1]);
    expect(result.decisionIds).toEqual(["d-event-0", "d-event-1"]);

    // Thinking aggregates
    expect(result.thinking.totalPromptTokens).toBe(400); // 100 + 300
    expect(result.thinking.totalCompletionTokens).toBe(130); // 50 + 80
    expect(result.thinking.totalTokens).toBe(530); // 150 + 380
    expect(result.thinking.finishReasons).toEqual(["stop", "length"]);
    expect(result.thinking.continuationRounds).toBe(1); // 0 + 1
    expect(result.thinking.providerChunks).toBe(2);

    // Decision aggregates
    expect(result.decision.totalPromptTokens).toBe(600); // 200 + 400
    expect(result.decision.totalCompletionTokens).toBe(60); // 20 + 40
    expect(result.decision.totalTokens).toBe(660); // 220 + 440
    expect(result.decision.finishReasons).toEqual(["stop", "length"]);
    expect(result.decision.continuationRounds).toBe(1); // 0 + 1
    expect(result.decision.providerChunks).toBe(2);
  });

  // ── edge cases ──

  it("handles events with no usage at all gracefully", () => {
    const usage: NormalizedFimUsage = {
      thinking: { finishReasons: [], continuationRounds: 0 },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-empty", usage)];

    const result = summarizeTokenUsage(events);
    expect(result.eventCount).toBe(1);
    expect(result.thinking.providerChunks).toBe(0);
    expect(result.decision.providerChunks).toBe(0);
    expect(result.thinking.totalPromptTokens).toBe(0);
  });

  it("handles non-model_usage_recorded events mixed in safely", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [{ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 }],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [
      {
        type: "run_started",
        runId: "r1",
        task: "test",
        cwd: "/tmp",
        timestamp: new Date().toISOString(),
      },
      {
        type: "model_requested",
        stepIndex: 0,
        timestamp: new Date().toISOString(),
      },
      makeUsageEvent(0, "d-mix", usage),
      {
        type: "io_wait_started",
        stepIndex: 0,
        wait: { reason: "test", minLevel: 0 },
        timestamp: new Date().toISOString(),
      },
    ];

    const result = summarizeTokenUsage(events);
    expect(result.eventCount).toBe(1);
    expect(result.stepIndexes).toEqual([0]);
    expect(result.decisionIds).toEqual(["d-mix"]);
    expect(result.thinking.totalPromptTokens).toBe(50);
  });

  it("handles malformed usage objects without crashing", () => {
    const usage = {
      thinking: null,
      decision: undefined,
    } as unknown as NormalizedFimUsage;
    const events: RunEvent[] = [makeUsageEvent(0, "d-malformed", usage)];

    const result = summarizeTokenUsage(events);
    expect(result.eventCount).toBe(1);
    expect(result.thinking.totalPromptTokens).toBe(0);
    expect(result.decision.totalPromptTokens).toBe(0);
  });

  it("handles non-integer and negative token values gracefully", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 100.7,   // floors to 100
            completion_tokens: -5,   // clamps to 0
            total_tokens: NaN,       // converts to 0
            prompt_cache_hit_tokens: "string" as any,  // converts to 0
          },
        ],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d-bounds", usage)];

    const result = summarizeTokenUsage(events);
    expect(result.thinking.totalPromptTokens).toBe(100);
    expect(result.thinking.totalCompletionTokens).toBe(0);
    expect(result.thinking.totalTokens).toBe(0);
    expect(result.thinking.totalCacheHitTokens).toBe(0);
  });
});

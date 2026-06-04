import { describe, expect, it } from "vitest";
import { buildTokenUsageView } from "../src/tui/token-usage-consumer.js";
import type { RunEvent } from "../src/types/run.js";
import type { NormalizedFimUsage } from "../src/model/token-usage-normalizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsageEvent(
  stepIndex: number,
  decisionId: string,
  usage: NormalizedFimUsage,
): Extract<RunEvent, { type: "model_usage_recorded" }> {
  return {
    type: "model_usage_recorded",
    stepIndex,
    decisionId,
    usage,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function emptyUsage(): NormalizedFimUsage {
  return {
    thinking: { finishReasons: [], continuationRounds: 0 },
    decision: { finishReasons: [], continuationRounds: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTokenUsageView", () => {
  it("returns empty view for empty events", () => {
    const view = buildTokenUsageView([]);
    expect(view.isEmpty).toBe(true);
    expect(view.eventCount).toBe(0);
    expect(view.stepIndexes).toEqual([]);
    expect(view.combinedTotalTokens).toBe(0);
  });

  it("returns empty view when no model_usage_recorded events present", () => {
    const events: RunEvent[] = [
      {
        type: "run_started",
        runId: "r1",
        task: "test",
        cwd: "/tmp",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "model_requested",
        stepIndex: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    const view = buildTokenUsageView(events);
    expect(view.isEmpty).toBe(true);
    expect(view.eventCount).toBe(0);
  });

  it("builds view from single model_usage_recorded event", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        ],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 200,
            completion_tokens: 30,
            total_tokens: 230,
          },
        ],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d0", usage)];

    const view = buildTokenUsageView(events);
    expect(view.isEmpty).toBe(false);
    expect(view.eventCount).toBe(1);
    expect(view.stepIndexes).toEqual([0]);

    // thinking totals
    expect(view.thinkingPromptTokens).toBe(100);
    expect(view.thinkingCompletionTokens).toBe(50);
    expect(view.thinkingTotalTokens).toBe(150);
    expect(view.thinkingCacheHitTokens).toBe(80);

    // decision totals
    expect(view.decisionPromptTokens).toBe(200);
    expect(view.decisionCompletionTokens).toBe(30);
    expect(view.decisionTotalTokens).toBe(230);
    expect(view.decisionCacheHitTokens).toBe(0);

    // combined
    expect(view.combinedPromptTokens).toBe(300);
    expect(view.combinedCompletionTokens).toBe(80);
    expect(view.combinedCacheHitTokens).toBe(80);
    expect(view.combinedTotalTokens).toBe(380);
  });

  it("aggregates across multiple events", () => {
    const usage1: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        ],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
        ],
      },
    };
    const usage2: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["length"],
        continuationRounds: 1,
        usages: [
          { prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 },
        ],
      },
      decision: {
        finishReasons: ["length"],
        continuationRounds: 1,
        usages: [
          { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 },
        ],
      },
    };
    const events: RunEvent[] = [
      makeUsageEvent(0, "d-event-0", usage1),
      makeUsageEvent(1, "d-event-1", usage2),
    ];

    const view = buildTokenUsageView(events);
    expect(view.eventCount).toBe(2);
    expect(view.stepIndexes).toEqual([0, 1]);

    expect(view.thinkingPromptTokens).toBe(400);
    expect(view.thinkingCompletionTokens).toBe(130);
    expect(view.thinkingTotalTokens).toBe(530);
    expect(view.decisionPromptTokens).toBe(600);
    expect(view.decisionCompletionTokens).toBe(60);
    expect(view.decisionTotalTokens).toBe(660);
    expect(view.combinedTotalTokens).toBe(1190);
  });

  it("generates shortLines for display", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 1000,
            completion_tokens: 200,
            total_tokens: 1200,
            prompt_cache_hit_tokens: 800,
            prompt_cache_miss_tokens: 200,
          },
        ],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
        ],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d0", usage)];

    const view = buildTokenUsageView(events);
    expect(view.shortLines.length).toBeGreaterThan(0);
    // Combined total line
    expect(view.shortLines.some((l) => l.includes("1.8k"))).toBe(true);
    // Thinking line
    expect(view.shortLines.some((l) => l.includes("think"))).toBe(true);
    // Decision line
    expect(view.shortLines.some((l) => l.includes("dec"))).toBe(true);
  });

  it("handles thinking-only usage", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        ],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d0", usage)];

    const view = buildTokenUsageView(events);
    expect(view.thinkingTotalTokens).toBe(150);
    expect(view.decisionTotalTokens).toBe(0);
    expect(view.combinedTotalTokens).toBe(150);
  });

  it("handles decision-only usage", () => {
    const usage: NormalizedFimUsage = {
      thinking: { finishReasons: [], continuationRounds: 0 },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
        ],
      },
    };
    const events: RunEvent[] = [makeUsageEvent(0, "d0", usage)];

    const view = buildTokenUsageView(events);
    expect(view.thinkingTotalTokens).toBe(0);
    expect(view.decisionTotalTokens).toBe(230);
    expect(view.combinedTotalTokens).toBe(230);
  });

  it("handles events with empty usage gracefully", () => {
    const events: RunEvent[] = [makeUsageEvent(0, "d-empty", emptyUsage())];

    const view = buildTokenUsageView(events);
    expect(view.eventCount).toBe(1);
    expect(view.combinedTotalTokens).toBe(0);
    expect(view.thinkingTotalTokens).toBe(0);
    expect(view.decisionTotalTokens).toBe(0);
  });

  it("handles malformed usage without crashing", () => {
    const usage = {
      thinking: null,
      decision: undefined,
    } as unknown as NormalizedFimUsage;
    const events: RunEvent[] = [makeUsageEvent(0, "d-mal", usage)];

    const view = buildTokenUsageView(events);
    expect(view.eventCount).toBe(1);
    expect(view.combinedTotalTokens).toBe(0);
  });

  it("handles mixed events with non-usage events", () => {
    const usage: NormalizedFimUsage = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
        ],
      },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
    const events: RunEvent[] = [
      { type: "run_started", runId: "r1", task: "t", cwd: "/", timestamp: "" },
      { type: "model_requested", stepIndex: 0, timestamp: "" },
      makeUsageEvent(0, "d-mix", usage),
      {
        type: "io_wait_started",
        stepIndex: 0,
        wait: { reason: "test", minLevel: 0 },
        timestamp: "",
      },
    ];

    const view = buildTokenUsageView(events);
    expect(view.eventCount).toBe(1);
    expect(view.combinedTotalTokens).toBe(55);
  });

  it("shortLines is empty when no usage", () => {
    const view = buildTokenUsageView([]);
    expect(view.shortLines).toEqual([]);
  });
});

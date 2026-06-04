import { describe, expect, it } from "vitest";
import {
  normalizeFimUsage,
  normalizePassUsage,
  type NormalizedFimUsage,
  type NormalizedPassUsage,
  type NormalizedProviderUsage,
} from "../src/model/token-usage-normalizer.js";

// ---------------------------------------------------------------------------
// normalizePassUsage
// ---------------------------------------------------------------------------

describe("normalizePassUsage", () => {
  it("returns empty default when input is null", () => {
    expect(normalizePassUsage(null)).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
  });

  it("returns empty default when input is a string", () => {
    expect(normalizePassUsage("garbage")).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
  });

  it("returns empty default when input is an array", () => {
    expect(normalizePassUsage([])).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
  });

  it("normalizes a well-formed pass with cache usage", () => {
    const input = {
      finishReasons: ["stop"],
      continuationRounds: 0,
      usages: [
        {
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
          completion_tokens: 3,
          total_tokens: 103,
          // extra unknown field
          custom_field: "keep-me",
        },
      ],
    };

    const result = normalizePassUsage(input);
    expect(result.finishReasons).toEqual(["stop"]);
    expect(result.continuationRounds).toBe(0);
    expect(result.usages).toHaveLength(1);
    expect(result.usages![0]).toMatchObject({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
      completion_tokens: 3,
      total_tokens: 103,
      custom_field: "keep-me",
    });
  });

  it("filters out non-record usages entries", () => {
    const input = {
      finishReasons: ["stop"],
      continuationRounds: 1,
      usages: [
        { completion_tokens: 5 },
        null,
        "bad",
        42,
        { prompt_tokens: 10 },
      ],
    };
    const result = normalizePassUsage(input);
    expect(result.usages).toHaveLength(2);
    expect(result.usages![0]).toMatchObject({ completion_tokens: 5 });
    expect(result.usages![1]).toMatchObject({ prompt_tokens: 10 });
  });

  it("omits usages when the array is empty after filtering", () => {
    const input = {
      finishReasons: ["stop"],
      continuationRounds: 0,
      usages: [null, "bad"] as unknown[],
    };
    const result = normalizePassUsage(input);
    expect(result.usages).toBeUndefined();
  });

  it("omits usages when input has no usages key", () => {
    const input = { finishReasons: ["length"], continuationRounds: 2 };
    const result = normalizePassUsage(input);
    expect(result.usages).toBeUndefined();
    expect(result.finishReasons).toEqual(["length"]);
    expect(result.continuationRounds).toBe(2);
  });

  it("handles non-array finishReasons by defaulting to empty", () => {
    const result = normalizePassUsage({
      finishReasons: "not-an-array",
      continuationRounds: 0,
    });
    expect(result.finishReasons).toEqual([]);
  });

  it("coerces non-string finishReason entries to strings", () => {
    const result = normalizePassUsage({
      finishReasons: [42, true, "stop", null, undefined],
      continuationRounds: 0,
    });
    expect(result.finishReasons).toEqual([
      "42",
      "true",
      "stop",
      null,
      undefined,
    ]);
  });

  it("defaults continuationRounds to 0 when missing", () => {
    const result = normalizePassUsage({ finishReasons: ["stop"] });
    expect(result.continuationRounds).toBe(0);
  });

  it("defaults continuationRounds to 0 when not a number", () => {
    const result = normalizePassUsage({
      finishReasons: ["stop"],
      continuationRounds: "seven",
    });
    expect(result.continuationRounds).toBe(0);
  });

  it("floors non-integer continuationRounds and clamps to 0", () => {
    const result = normalizePassUsage({
      finishReasons: ["stop"],
      continuationRounds: 3.7,
    });
    expect(result.continuationRounds).toBe(3);
  });

  it("clamps negative continuationRounds to 0", () => {
    const result = normalizePassUsage({
      finishReasons: ["stop"],
      continuationRounds: -1,
    });
    expect(result.continuationRounds).toBe(0);
  });

  it("preserves camelCase and snake_case cache fields", () => {
    const input = {
      finishReasons: ["stop"],
      continuationRounds: 0,
      usages: [
        {
          promptTokens: 200,
          promptCacheHitTokens: 150,
          promptCacheMissTokens: 50,
          completionTokens: 8,
          totalTokens: 208,
        },
      ],
    };
    const result = normalizePassUsage(input);
    expect(result.usages![0]).toMatchObject({
      promptTokens: 200,
      promptCacheHitTokens: 150,
      promptCacheMissTokens: 50,
      completionTokens: 8,
      totalTokens: 208,
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeFimUsage
// ---------------------------------------------------------------------------

describe("normalizeFimUsage", () => {
  it("returns safe empty defaults for null input", () => {
    const result: NormalizedFimUsage = normalizeFimUsage(null);
    expect(result).toEqual({
      thinking: { finishReasons: [], continuationRounds: 0 },
      decision: { finishReasons: [], continuationRounds: 0 },
    });
  });

  it("returns safe empty defaults for non-object input", () => {
    expect(normalizeFimUsage("bad")).toEqual({
      thinking: { finishReasons: [], continuationRounds: 0 },
      decision: { finishReasons: [], continuationRounds: 0 },
    });
  });

  it("normalizes a real DeepSeek FIM payload with cached tokens", () => {
    const raw = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            prompt_tokens: 1200,
            prompt_cache_hit_tokens: 800,
            prompt_cache_miss_tokens: 400,
            completion_tokens: 150,
            total_tokens: 1350,
          },
        ],
      },
      decision: {
        finishReasons: ["length", "stop"],
        continuationRounds: 1,
        usages: [
          {
            prompt_tokens: 1400,
            prompt_cache_hit_tokens: 1350,
            prompt_cache_miss_tokens: 50,
            completion_tokens: 4,
          },
          {
            prompt_tokens: 1410,
            prompt_cache_hit_tokens: 1360,
            prompt_cache_miss_tokens: 50,
            completion_tokens: 8,
            total_tokens: 1418,
          },
        ],
      },
    };

    const result = normalizeFimUsage(raw);

    // thinking pass
    expect(result.thinking.finishReasons).toEqual(["stop"]);
    expect(result.thinking.continuationRounds).toBe(0);
    expect(result.thinking.usages).toHaveLength(1);
    expect(result.thinking.usages![0].prompt_cache_hit_tokens).toBe(800);
    expect(result.thinking.usages![0].prompt_cache_miss_tokens).toBe(400);

    // decision pass with two continuation chunks
    expect(result.decision.finishReasons).toEqual(["length", "stop"]);
    expect(result.decision.continuationRounds).toBe(1);
    expect(result.decision.usages).toHaveLength(2);
    expect(result.decision.usages![1].completion_tokens).toBe(8);
  });

  it("handles missing usage (only finishReasons and continuationRounds)", () => {
    const raw = {
      thinking: { finishReasons: ["stop"], continuationRounds: 0 },
      decision: { finishReasons: ["length"], continuationRounds: 2 },
    };
    const result = normalizeFimUsage(raw);
    expect(result.thinking.usages).toBeUndefined();
    expect(result.decision.usages).toBeUndefined();
    expect(result.thinking.finishReasons).toEqual(["stop"]);
    expect(result.decision.continuationRounds).toBe(2);
  });

  it("handles missing thinking key gracefully", () => {
    const result = normalizeFimUsage({
      decision: { finishReasons: ["stop"], continuationRounds: 0 },
    });
    expect(result.thinking).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
    expect(result.decision.finishReasons).toEqual(["stop"]);
  });

  it("handles missing decision key gracefully", () => {
    const result = normalizeFimUsage({
      thinking: { finishReasons: ["stop"], continuationRounds: 0 },
    });
    expect(result.decision).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
    expect(result.thinking.finishReasons).toEqual(["stop"]);
  });

  it("handles malformed thinking/decision values gracefully", () => {
    const result = normalizeFimUsage({
      thinking: "not-an-object",
      decision: null,
    });
    expect(result.thinking).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
    expect(result.decision).toEqual({
      finishReasons: [],
      continuationRounds: 0,
    });
  });

  it("preserves unknown fields in provider usage objects", () => {
    const raw = {
      thinking: {
        finishReasons: ["stop"],
        continuationRounds: 0,
        usages: [
          {
            completion_tokens: 5,
            unknown_vendor_field: { nested: true },
            another_flag: "yes",
          },
        ],
      },
      decision: {
        finishReasons: ["stop"],
        continuationRounds: 0,
      },
    };
    const result = normalizeFimUsage(raw);
    const usage = result.thinking.usages![0];
    expect(usage.completion_tokens).toBe(5);
    expect(usage.unknown_vendor_field).toEqual({ nested: true });
    expect(usage.another_flag).toBe("yes");
  });
});

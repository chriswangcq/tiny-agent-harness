/** Typed production normalizer for DeepSeek FIM usage payloads. */

/**
 * Known provider-level usage fields from a single FIM stream chunk.
 * Unknown fields are preserved in the index signature.
 */
export interface NormalizedProviderUsage {
  /** Prompt tokens consumed (snake_case). */
  prompt_tokens?: number;
  /** Prompt tokens consumed (camelCase).  */
  promptTokens?: number;
  /** Cached prompt tokens hit (snake_case). */
  prompt_cache_hit_tokens?: number;
  /** Cached prompt tokens hit (camelCase). */
  promptCacheHitTokens?: number;
  /** Cached prompt tokens missed (snake_case). */
  prompt_cache_miss_tokens?: number;
  /** Cached prompt tokens missed (camelCase). */
  promptCacheMissTokens?: number;
  /** Completion tokens generated (snake_case). */
  completion_tokens?: number;
  /** Completion tokens generated (camelCase). */
  completionTokens?: number;
  /** Total tokens (snake_case). */
  total_tokens?: number;
  /** Total tokens (camelCase). */
  totalTokens?: number;
  /** Unknown / forward-compatible provider fields. */
  [key: string]: unknown;
}

/**
 * Normalized usage for a single FIM pass (thinking or decision).
 */
export interface NormalizedPassUsage {
  /** Finish reasons collected across continuation rounds. */
  finishReasons: Array<string | null | undefined>;
  /** Number of continuation rounds for this pass. */
  continuationRounds: number;
  /**
   * Provider-level usage objects collected from streamed SSE chunks.
   * DeepSeek cache fields such as prompt_cache_hit_tokens and
   * prompt_cache_miss_tokens are preserved here.
   */
  usages?: NormalizedProviderUsage[];
}

/**
 * Normalized FIM usage with separate thinking and decision pass data.
 */
export interface NormalizedFimUsage {
  thinking: NormalizedPassUsage;
  decision: NormalizedPassUsage;
}

/**
 * Validate that a value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a single pass usage meta object.
 *
 * Accepts `unknown` input from adapter internals and produces a
 * well-typed NormalizedPassUsage.  Missing / malformed input returns
 * a safe empty default.
 */
export function normalizePassUsage(
  input: unknown,
): NormalizedPassUsage {
  if (!isRecord(input)) {
    return { finishReasons: [], continuationRounds: 0 };
  }

  // finishReasons must be an array.
  const rawReasons = input.finishReasons;
  const finishReasons: Array<string | null | undefined> =
    Array.isArray(rawReasons)
      ? rawReasons.map((r) =>
          typeof r === "string"
            ? r
            : r == null
              ? r
              : String(r),
        )
      : [];

  // continuationRounds must be a number; default to 0.
  const rawRounds = input.continuationRounds;
  const continuationRounds =
    typeof rawRounds === "number" && Number.isFinite(rawRounds)
      ? Math.max(0, Math.floor(rawRounds))
      : 0;

  // usages must be an array of non-null objects.
  let usages: NormalizedProviderUsage[] | undefined;
  const rawUsages = input.usages;
  if (Array.isArray(rawUsages)) {
    const normalized: NormalizedProviderUsage[] = [];
    for (const u of rawUsages) {
      if (isRecord(u)) {
        normalized.push({ ...u } as NormalizedProviderUsage);
      }
    }
    if (normalized.length > 0) {
      usages = normalized;
    }
  }

  return { finishReasons, continuationRounds, ...(usages ? { usages } : {}) };
}

/**
 * Normalize a raw FIM step output `usage` value.
 *
 * The input is the `usage` field produced by {@link DeepSeekFimAdapter.generateTurn}
 * (currently `unknown`), which has the shape:
 *
 * ```ts
 * {
 *   thinking: FimCompletionMeta,
 *   decision: FimCompletionMeta,
 * }
 * ```
 *
 * This normalizer is the single typed entry-point. Tests import it directly —
 * they **must not** copy private adapter logic.
 *
 * @returns A fully-typed NormalizedFimUsage.  If the input is completely
 *          unrecognisable, both passes default to empty usage.
 */
export function normalizeFimUsage(
  input: unknown,
): NormalizedFimUsage {
  if (!isRecord(input)) {
    return {
      thinking: { finishReasons: [], continuationRounds: 0 },
      decision: { finishReasons: [], continuationRounds: 0 },
    };
  }

  return {
    thinking: normalizePassUsage(input.thinking),
    decision: normalizePassUsage(input.decision),
  };
}

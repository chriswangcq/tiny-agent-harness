import { describe, expect, it } from "vitest";
import { DeterministicHistoryCompactor } from "../src/run/context-window.js";
import type { HistoryItem } from "../src/run/orchestrator.js";

describe("DeterministicHistoryCompactor", () => {
  it("uses an explicit timestamp provider for deterministic summaries", () => {
    const history: HistoryItem[] = [
      { type: "environment_reminder", content: "Environment reminder:\n[user@default] old task" },
      { type: "environment_reminder", content: "recent context" },
    ];
    const compactor = new DeterministicHistoryCompactor({
      recentItemCount: 1,
      now: () => "2026-05-31T08:00:00.000Z",
    });

    const result = compactor.compact({
      history,
      tokenCount: 10,
      maxTokens: 5,
      stepIndex: 7,
    });

    expect(result?.summary).toContain(
      "Compression timestamp: 2026-05-31T08:00:00.000Z",
    );
    expect(result?.history[0]).toMatchObject({
      type: "environment_reminder",
      content: expect.stringContaining(
        "Compression timestamp: 2026-05-31T08:00:00.000Z",
      ),
    });
  });
});

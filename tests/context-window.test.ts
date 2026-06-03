import { describe, expect, it } from "vitest";
import { DeterministicModelContextCompactor } from "../src/model/context-window.js";
import type { ModelContextItem } from "../src/model/context-session.js";

describe("DeterministicModelContextCompactor", () => {
  it("uses an explicit timestamp provider for deterministic summaries", () => {
    const items: ModelContextItem[] = [
      { type: "environment_reminder", content: "Environment reminder:\n[user@default] old task" },
      { type: "environment_reminder", content: "recent context" },
    ];
    const compactor = new DeterministicModelContextCompactor({
      recentItemCount: 1,
      now: () => "2026-05-31T08:00:00.000Z",
    });

    const result = compactor.compact({
      items,
      tokenCount: 10,
      maxTokens: 5,
      stepIndex: 7,
    });

    expect(result?.summary).toContain(
      "Compression timestamp: 2026-05-31T08:00:00.000Z",
    );
    expect(result?.items[0]).toMatchObject({
      type: "environment_reminder",
      content: expect.stringContaining(
        "Compression timestamp: 2026-05-31T08:00:00.000Z",
      ),
    });
  });
});

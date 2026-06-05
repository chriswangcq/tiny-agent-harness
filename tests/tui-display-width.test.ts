import { describe, it, expect } from "vitest";
import {
  displayWidth,
  truncateDisplayText,
  stripBlessedTags,
  graphemeClusters,
  sanitizeDisplayText,
  padBlessedLineForDisplay,
} from "../src/tui/renderer.js";

describe("displayWidth", () => {
  it("returns 0 for empty string", () => {
    expect(displayWidth("")).toBe(0);
  });

  it("counts ASCII correctly", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("a")).toBe(1);
    expect(displayWidth("test 123")).toBe(8);
  });

  it("counts CJK characters as width 2", () => {
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("한국어")).toBe(6);
  });

  it("handles mixed ASCII and CJK", () => {
    expect(displayWidth("hello世界")).toBe(9);
    expect(displayWidth("a中文b")).toBe(6);
  });

  it("handles spaces and punctuation", () => {
    expect(displayWidth("   ")).toBe(3);
    expect(displayWidth("hello, 世界!")).toBe(12);
  });
});

describe("truncateDisplayText", () => {
  it("returns original if shorter than width", () => {
    expect(truncateDisplayText("hello", 10)).toBe("hello");
  });

  it("clips and adds ... suffix when truncating", () => {
    // width 5, "..." takes 3, so 2 chars of content
    const result = truncateDisplayText("hello world", 5);
    expect(displayWidth(result)).toBeLessThanOrEqual(5);
    expect(result).toContain("...");
  });

  it("clips CJK with suffix", () => {
    // width 6, "..." takes 3, content = 3. With CJK: "中" = 2, next char would be 2+2=4 > 3
    const result = truncateDisplayText("中文测试文本", 6);
    expect(displayWidth(result)).toBeLessThanOrEqual(6);
    expect(result).toBe("中..."); // 2 + 3 = 5 <= 6
  });

  it("clips mixed ASCII+CJK", () => {
    // width 9, "..." = 3, content = 6. "hello"=5, "世"=2, 5+2=7 > 6
    const result = truncateDisplayText("hello世界test", 9);
    expect(displayWidth(result)).toBeLessThanOrEqual(9);
    expect(result).toContain("...");
    // "hello" (5) + "..." (3) = 8 <= 9
  });

  it("no suffix when width <= 3", () => {
    const result = truncateDisplayText("hello", 1);
    expect(displayWidth(result)).toBeLessThanOrEqual(1);
    expect(result).not.toContain("...");
  });
});

describe("stripBlessedTags", () => {
  it("removes bold tags", () => {
    expect(stripBlessedTags("{bold}hello{/bold}")).toBe("hello");
  });

  it("removes multiple tags", () => {
    expect(stripBlessedTags("{bold}{cyan-fg}text{/cyan-fg}{/bold}")).toBe("text");
  });

  it("leaves plain text unchanged", () => {
    expect(stripBlessedTags("hello world")).toBe("hello world");
  });

  it("removes tags with various content", () => {
    expect(stripBlessedTags("{right}aligned{/right}")).toBe("aligned");
    expect(stripBlessedTags("{center}centered{/center}")).toBe("centered");
  });
});

describe("sanitizeDisplayText", () => {
  it("preserves plain text", () => {
    expect(sanitizeDisplayText("hello")).toBe("hello");
  });

  it("removes control characters", () => {
    expect(sanitizeDisplayText("hello\x00world")).toBe("helloworld");
    expect(sanitizeDisplayText("test\x1b[31mred\x1b[0m")).toBe("testred");
  });
});

describe("padBlessedLineForDisplay", () => {
  it("pads short lines", () => {
    const result = padBlessedLineForDisplay("hi", 5);
    expect(displayWidth(stripBlessedTags(result))).toBeGreaterThanOrEqual(5);
  });

  it("returns line as-is if wider than target", () => {
    const result = padBlessedLineForDisplay("hello world", 5);
    expect(result).toBe("hello world");
  });

  it("handles blessed tags in width computation", () => {
    const result = padBlessedLineForDisplay("{bold}hi{/bold}", 5);
    expect(displayWidth(stripBlessedTags(result))).toBeGreaterThanOrEqual(5);
  });
});

describe("graphemeClusters", () => {
  it("splits ASCII into individual chars", () => {
    expect(graphemeClusters("abc")).toEqual(["a", "b", "c"]);
  });

  it("keeps CJK characters as single clusters", () => {
    const clusters = graphemeClusters("中文");
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toBe("中");
    expect(clusters[1]).toBe("文");
  });
});

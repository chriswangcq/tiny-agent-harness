import { describe, expect, it } from "vitest";
import { normalizeTerminalScreenText } from "../src/terminal/screen.js";

describe("terminal screen viewport", () => {
  it("keeps only the final viewport rows", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");

    expect(normalizeTerminalScreenText(text, { rows: 4, cols: 80 })).toBe(
      ["line-6", "line-7", "line-8", "line-9"].join("\n"),
    );
  });

  it("wraps by terminal columns before taking the final rows", () => {
    expect(normalizeTerminalScreenText("abcdefghij\nlast", { rows: 3, cols: 4 })).toBe(
      ["efgh", "ij", "last"].join("\n"),
    );
  });

  it("normalizes CRLF and CR line endings before viewport clipping", () => {
    expect(normalizeTerminalScreenText("a\r\nb\rc", { rows: 2, cols: 80 })).toBe(
      ["b", "c"].join("\n"),
    );
  });
});

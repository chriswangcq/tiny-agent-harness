import { describe, expect, it } from "vitest";
import {
  isRawShiftEnterSequence,
  isShiftEnterKey,
  renderInputBufferForBox,
} from "../src/tui/renderer.js";

describe("TUI input rendering", () => {
  it("keeps the cursor at the end of the visible multiline input", () => {
    const rendered = renderInputBufferForBox("first\nsecond", 20, 3);

    expect(rendered.content).toBe("first\nsecond");
    expect(rendered.cursorLine).toBe(1);
    expect(rendered.cursorCol).toBe(6);
  });

  it("keeps only the bottom lines when the input is taller than the box", () => {
    const rendered = renderInputBufferForBox("one\ntwo\nthree\nfour", 20, 3);

    expect(rendered.content).toBe("two\nthree\nfour");
    expect(rendered.cursorLine).toBe(2);
    expect(rendered.cursorCol).toBe(4);
  });

  it("wraps wide text while reserving a cursor cell", () => {
    const rendered = renderInputBufferForBox("ab中文c", 6, 3);

    expect(rendered.content).toBe("ab中\n文c");
    expect(rendered.cursorLine).toBe(1);
    expect(rendered.cursorCol).toBe(3);
  });

  it("recognizes Shift+Enter as newline input", () => {
    expect(isShiftEnterKey({ name: "enter", shift: true })).toBe(true);
    expect(isShiftEnterKey({ name: "return", shift: true })).toBe(true);
    expect(isShiftEnterKey({ name: "linefeed", shift: true })).toBe(true);
    expect(isShiftEnterKey({ name: "enter", shift: false })).toBe(false);
  });

  it("recognizes raw terminal Shift+Enter sequences dropped by keypress parsing", () => {
    expect(isRawShiftEnterSequence("\x1b[13;2u")).toBe(true);
    expect(isRawShiftEnterSequence("\x1b[13;2U")).toBe(true);
    expect(isRawShiftEnterSequence("\x1b[13;2~")).toBe(true);
    expect(isRawShiftEnterSequence("\x1b[27;2;13~")).toBe(true);
    expect(isRawShiftEnterSequence("\r")).toBe(false);
    expect(isRawShiftEnterSequence("\n")).toBe(false);
    expect(isRawShiftEnterSequence("\x1b[13;5u")).toBe(false);
  });
});

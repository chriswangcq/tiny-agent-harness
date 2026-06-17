import { describe, expect, it } from "vitest";
import {
  createTuiInputEditorState,
  reduceTuiInputEditor,
} from "../src/tui/input-editor.js";

describe("TuiInputEditor", () => {
  it("inserts printable text and explicit newlines", () => {
    let result = reduceTuiInputEditor(createTuiInputEditorState(), {
      kind: "insert-text",
      text: "hello",
    });
    result = reduceTuiInputEditor(result.state, { kind: "insert-newline" });
    result = reduceTuiInputEditor(result.state, {
      kind: "insert-text",
      text: "world",
    });

    expect(result.state.buffer).toBe("hello\nworld");
  });

  it("removes one grapheme cluster on backspace", () => {
    const result = reduceTuiInputEditor(createTuiInputEditorState("👨‍💻x"), {
      kind: "backspace",
    });
    const second = reduceTuiInputEditor(result.state, { kind: "backspace" });

    expect(result.state.buffer).toBe("👨‍💻");
    expect(second.state.buffer).toBe("");
  });

  it("submits trimmed text and clears the buffer", () => {
    const result = reduceTuiInputEditor(createTuiInputEditorState("hello  \n"), {
      kind: "submit",
    });

    expect(result).toEqual({
      state: { buffer: "" },
      submittedText: "hello",
    });
  });

  it("clears empty submits without emitting a message", () => {
    const result = reduceTuiInputEditor(createTuiInputEditorState(" \n\t"), {
      kind: "submit",
    });

    expect(result).toEqual({ state: { buffer: "" } });
  });
});

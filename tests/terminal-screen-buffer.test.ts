import { describe, expect, it } from "vitest";
import {
  stripManagedShellScreenNoise,
  XtermTerminalScreenBuffer,
} from "../src/terminal/index.js";

describe("XtermTerminalScreenBuffer", () => {
  it("renders the current viewport, not an append-only log tail", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 4, cols: 40 });

    buffer.write("hello world\rreplacement\r\nline-2");

    const screen = await buffer.snapshot();

    expect(screen).toMatchObject({ rows: 4, cols: 40, hasScrollback: false });
    expect(screen.text).toContain("replacement");
    expect(screen.text).not.toContain("hello world");
    expect(screen.text).toContain("line-2");
    expect(screen.text.split("\n")).toHaveLength(4);
    buffer.dispose();
  });


  it("handles backspace overwrite like a real terminal", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 3, cols: 20 });

    buffer.write("ab\bX\r\n");

    const screen = await buffer.snapshot();

    expect(screen.text.split("\n")[0]).toBe("aX");
    buffer.dispose();
  });

  it("handles consecutive backspaces with overwrite", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 3, cols: 20 });

    buffer.write("abc\b\bXY\r\n");

    const screen = await buffer.snapshot();

    expect(screen.text.split("\n")[0]).toBe("aXY");
    buffer.dispose();
  });

  it("handles backspace with UTF-8 multi-byte characters", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 3, cols: 20 });

    buffer.write("a\u4e2d\bX\r\n");

    const screen = await buffer.snapshot();

    expect(screen.text.split("\n")[0]).toBe("a X");
    buffer.dispose();
  });

  it("handles ANSI clear-screen and cursor positioning", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 3, cols: 20 });

    buffer.write("old\r\ncontent\r\n\x1b[2J\x1b[Hnew");

    const screen = await buffer.snapshot();

    expect(screen.text.split("\n")[0]).toBe("new");
    expect(screen.text).not.toContain("old");
    buffer.dispose();
  });

  it("keeps only the final carriage-return redraw state", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 6, cols: 80 });

    buffer.write(
      "<经验沉淀 system lessons 写回 skil\r" +
        "<经验沉淀 system lessons 写回 skill\r" +
        "<经验沉淀 system lessons 写回 skill 定义。\r\n" +
        "> EOF\r\nok=true\r\n$ ",
    );

    const screen = await buffer.snapshot();

    expect(screen.text).toContain("<经验沉淀 system lessons 写回 skill 定义。");
    expect(screen.text).not.toContain("写回 skil\n");
    expect(screen.text).toContain("ok=true");
    buffer.dispose();
  });

  it("removes managed shell marker lines from the visible screen", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 4, cols: 40 });

    buffer.write("__TAH_PROMPT__ nonce=n rc=0 cwd=/repo seq=1\r\n$ ");

    const screen = await buffer.snapshot();

    expect(screen.text).toContain("$");
    expect(screen.text).not.toContain("__TAH_PROMPT__");
    buffer.dispose();
  });

  it("removes managed shell marker lines after a visible shell prompt prefix", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 4, cols: 80 });

    buffer.write("> __TAH_CONT__ nonce=n reason=unknown seq=1\r\n> ");

    const screen = await buffer.snapshot();

    expect(screen.text).not.toContain("> __TAH_CONT__");
    expect(screen.text).not.toContain("> ");
    expect(screen.text).not.toContain("__TAH_CONT__");
    buffer.dispose();
  });

  it("removes continuation prompt chrome while preserving heredoc content", async () => {
    const buffer = new XtermTerminalScreenBuffer({ rows: 6, cols: 80 });

    buffer.write(
      "__TAH_CONT__ nonce=n reason=unknown seq=1\r\n" +
        "> 这 9 个失败在我们改动 `state/root.ts` **之前**就已存在\r\n" +
        "__TAH_CONT__ nonce=n reason=unknown seq=1\r\n" +
        "> | Terminal | `terminal-*.test.ts` | ✓ |\r\n",
    );

    const screen = await buffer.snapshot();

    expect(screen.text).toContain(
      "这 9 个失败在我们改动 `state/root.ts` **之前**就已存在",
    );
    expect(screen.text).toContain("| Terminal | `terminal-*.test.ts` | ✓ |");
    expect(screen.text).not.toContain("**之> 前**");
    expect(screen.text).not.toContain("> | Terminal");
    expect(screen.text).not.toContain("__TAH_CONT__");
    buffer.dispose();
  });

});

describe("stripManagedShellScreenNoise", () => {
  it("holds split marker prefixes until the line can be classified", () => {
    const first = stripManagedShellScreenNoise("__TAH_PRO");
    expect(first.output).toBe("");
    expect(first.pending).toBe("__TAH_PRO");

    const second = stripManagedShellScreenNoise(
      "MPT__ nonce=n rc=0 cwd=/ seq=1\r\n$ ",
      first.state,
    );
    expect(second.output).toBe("$ ");
    expect(second.pending).toBe("");
  });

  it("holds split marker prefixes after a visible shell prompt prefix", () => {
    const first = stripManagedShellScreenNoise("> __TAH_CO");
    expect(first.output).toBe("");
    expect(first.pending).toBe("> __TAH_CO");

    const second = stripManagedShellScreenNoise(
      "NT__ nonce=n reason=unknown seq=1\r\n> ",
      first.state,
    );
    expect(second.output).toBe("");
    expect(second.pending).toBe("");
  });

  it("does not remove user output that merely mentions a marker", () => {
    const result = stripManagedShellScreenNoise(
      "literal text __TAH_CONT__ nonce=n reason=unknown seq=1\r\n",
    );

    expect(result.output).toBe(
      "literal text __TAH_CONT__ nonce=n reason=unknown seq=1\r\n",
    );
    expect(result.pending).toBe("");
  });

  it("strips managed shell prompt counter setup lines", () => {
    const result = stripManagedShellScreenNoise(
      [
        "export TAH_PROMPT_RC=0\r\n",
        "export PROMPT_COMMAND='TAH_PROMPT_RC=$?; TAH_PROMPT_SEQ=$((TAH_PROMPT_SEQ + 1))'\r\n",
        "visible output\r\n",
      ].join(""),
    );

    expect(result.output).toBe("visible output\r\n");
    expect(result.pending).toBe("");
  });

  it("resets continuation after PROMPT and preserves blockquote > prefix", () => {
    const first = stripManagedShellScreenNoise(
      "__TAH_CONT__ nonce=n reason=unknown seq=1\r\n> ",
    );
    expect(first.state.pendingPromptKind).toBe("continuation");

    const second = stripManagedShellScreenNoise(
      "__TAH_PROMPT__ nonce=n rc=0 cwd=/repo seq=2\r\n> user blockquote should stay\n",
      first.state,
    );
    expect(second.output).toBe("> user blockquote should stay\n");
    expect(second.state.pendingPromptKind).toBeNull();
  });
});

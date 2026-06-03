import { describe, expect, it } from "vitest";
import wcwidth from "wcwidth";
import {
  consumeRawShiftEnterEchoCandidate,
  isRawCtrlCSequence,
  isRawShiftEnterSequence,
  isShiftEnterKey,
  padBlessedLineForDisplay,
  planTuiLayout,
  rawShiftEnterEchoCandidates,
  renderConversationBodyLinesForDisplay,
  renderInputBufferForBox,
  renderStyledTuiFrame,
  renderPtySessionForDisplay,
  renderTuiFrame,
  sanitizeDisplayText,
  selectPtySession,
  truncateDisplayText,
  wrapDisplayText,
} from "../src/tui/renderer.js";
import { TuiInteractionState } from "../src/tui/interaction-state.js";
import type { LoopFrame, SessionView, TuiViewModel } from "../src/tui/types.js";

function session(
  name: string,
  updatedAt: string,
  tail = "",
  overrides: Partial<SessionView> = {},
): SessionView {
  return {
    session: name,
    updatedAt,
    state: "idle",
    logPath: `pty://${name}`,
    tail,
    ...overrides,
  };
}

function displayWidth(value: string): number {
  return Array.from(value).reduce((sum, ch) => sum + Math.max(0, wcwidth(ch)), 0);
}

function frame(id: string): LoopFrame {
  return {
    id,
    stepIndex: 1,
    timestamp: "2026-01-01T00:00:00Z",
    phase: "tool",
    status: "ok",
    title: "terminal_write ok",
    summary: "short",
    detail: "detail line",
  };
}

function view(): TuiViewModel {
  return {
    run: {
      runId: "run-1",
      status: "waiting_for_io",
      stepIndex: 3,
      cwd: "/repo",
    },
    conversation: [
      {
        id: "msg-1",
        kind: "agent",
        messageKind: "status",
        timestamp: "2026-01-01T00:00:00Z",
        text: "short\n| npm test | 410/410 | ok |",
      },
    ],
    loop: [frame("frame-1")],
    sessions: [
      {
        ...session("default", "2026-01-01T00:00:01Z", "pty tail"),
        currentCommand: "npm test",
        returnCode: 0,
        tailOffset: 9,
      },
    ],
    activeSkills: [],
  };
}

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

  it("keeps emoji grapheme clusters intact in the input buffer", () => {
    const rendered = renderInputBufferForBox("👨‍💻x", 4, 3);

    expect(rendered.content).toBe("👨‍💻x");
    expect(rendered.cursorLine).toBe(0);
    expect(rendered.cursorCol).toBe(3);
  });

  it("can render a visible input cursor marker in the reserved cell", () => {
    const rendered = renderInputBufferForBox("abc", 6, 3, true);

    expect(rendered.content).toBe("abc█");
    expect(rendered.cursorLine).toBe(0);
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

  it("recognizes raw Ctrl+C sequences even with modified key reporting", () => {
    expect(isRawCtrlCSequence("\x03")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[27;5;99~")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[27;5;67~")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[99;5u")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[99;5U")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[67;5u")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[3;5u")).toBe(true);
    expect(isRawCtrlCSequence("\x1b[27;2;13~")).toBe(false);
    expect(isRawCtrlCSequence("c")).toBe(false);
  });

  it("suppresses printable residue emitted after raw Shift+Enter", () => {
    const echoes = rawShiftEnterEchoCandidates("\x1b[27;2;13~");

    expect(echoes).toEqual(["[27;2;13~", "27;2;13~"]);

    expect(consumeRawShiftEnterEchoCandidate(echoes, "27;2;13~")).toEqual({
      consumed: true,
      remaining: [],
    });
    expect(consumeRawShiftEnterEchoCandidate(echoes, "嗯")).toEqual({
      consumed: false,
      remaining: echoes,
    });
  });

  it("suppresses Shift+Enter residue when keypress parsing emits it in chunks", () => {
    const first = consumeRawShiftEnterEchoCandidate(
      rawShiftEnterEchoCandidates("\x1b[27;2;13~"),
      "[",
    );
    const second = consumeRawShiftEnterEchoCandidate(first.remaining, "27;");
    const third = consumeRawShiftEnterEchoCandidate(second.remaining, "2;13~");

    expect(first).toEqual({ consumed: true, remaining: ["27;2;13~"] });
    expect(second).toEqual({ consumed: true, remaining: ["2;13~"] });
    expect(third).toEqual({ consumed: true, remaining: [] });
  });

  it("prefers the default PTY session even when it is older", () => {
    const selected = selectPtySession([
      session("worker", "2026-01-01T00:00:03Z"),
      session("default", "2026-01-01T00:00:01Z"),
    ]);

    expect(selected?.session).toBe("default");
  });

  it("selects the most recently updated PTY session when default is absent", () => {
    const selected = selectPtySession([
      session("zeta", "2026-01-01T00:00:01Z"),
      session("alpha", "2026-01-01T00:00:03Z"),
    ]);

    expect(selected?.session).toBe("alpha");
  });

  it("uses session name as a deterministic PTY tie-breaker", () => {
    const selected = selectPtySession([
      session("bravo", "2026-01-01T00:00:01Z"),
      session("alpha", "2026-01-01T00:00:01Z"),
    ]);

    expect(selected?.session).toBe("alpha");
  });

  it("renders PTY display from the latest plain-text tail chars", () => {
    const rendered = renderPtySessionForDisplay(
      {
        ...session("worker", "2026-01-01T00:00:01Z", "prefix-new{tail}"),
        currentCommand: "npm test",
        returnCode: 0,
        tailOffset: 123,
      },
      9,
    );

    expect(rendered).toContain("worker: idle (cmd=npm test, rc=0, offset=123)");
    expect(rendered).toContain("new{tail}");
    expect(rendered).not.toContain("prefix");
  });

  it("sanitizes terminal control sequences before display", () => {
    expect(sanitizeDisplayText("plain\x1b[31m red\x1b[0m\r\nab\bX")).toBe(
      "plain red\naX",
    );
  });

  it("wraps sanitized display text by character width", () => {
    expect(wrapDisplayText("ab中文c", 5)).toEqual(["ab中", "文c"]);
    expect(wrapDisplayText("a\x1b[31mbcdef", 3)).toEqual(["abc", "def"]);
  });

  it("measures emoji grapheme clusters as terminal cells", () => {
    expect(wrapDisplayText("A👨‍💻B", 4)).toEqual(["A👨‍💻B"]);
    expect(wrapDisplayText("🏳️‍🌈ok", 4)).toEqual(["🏳️‍🌈ok"]);
  });

  it("truncates markdown table lines instead of wrapping them into fragments", () => {
    const lines = renderConversationBodyLinesForDisplay(
      "| Command | Result | Notes |\n| npm test | 401/401 | all green |",
      16,
    );

    expect(lines).toEqual(["| Command | R...", "| npm test | ..."]);
  });

  it("renders markdown table blocks as aligned terminal tables", () => {
    const lines = renderConversationBodyLinesForDisplay(
      [
        "| Command | Result | Notes |",
        "| --- | ---: | :---: |",
        "| npm test | 401/401 | all green |",
        "| build | ✅ | done |",
      ].join("\n"),
      40,
    );

    expect(lines).toEqual([
      "Command    Result    Notes",
      "────────  ───────  ─────────",
      "npm test  401/401  all green",
      "build          ✅    done",
    ]);
  });

  it("wraps markdown table cells when the pane is narrow", () => {
    const lines = renderConversationBodyLinesForDisplay(
      [
        "| Command | Result | Notes |",
        "| --- | ---: | :---: |",
        "| npm test | 401/401 | all green |",
      ].join("\n"),
      20,
    );

    expect(lines).toEqual([
      "Comma  Resul  Notes",
      "nd         t",
      "─────  ─────  ──────",
      "npm t  401/4  all gr",
      "est       01   een",
    ]);
  });

  it("renders a terminal-friendly markdown subset", () => {
    const lines = renderConversationBodyLinesForDisplay(
      [
        "# Result",
        "- **build** `ok`",
        "- [x] ship",
        "1. next",
        "> see [docs](https://x.y)",
        "```ts",
        "const ok = true;",
        "```",
      ].join("\n"),
      40,
    );

    expect(lines).toEqual([
      "Result",
      "• build ok",
      "☑ ship",
      "1. next",
      "│ see docs (https://x.y)",
      "┌─ code ts",
      "│ const ok = true;",
      "└─",
    ]);
  });

  it("wraps markdown list continuations under the item text", () => {
    expect(renderConversationBodyLinesForDisplay("- **abcdef**", 6)).toEqual([
      "• abcd",
      "  ef",
    ]);
  });

  it("wraps regular conversation prose while table text can be clipped", () => {
    expect(renderConversationBodyLinesForDisplay("abcdef", 3)).toEqual([
      "abc",
      "def",
    ]);
    expect(truncateDisplayText("| ab中文c | done |", 8)).toBe("| ab...");
  });

  it("does not truncate conversation bodies unless a caller opts in", () => {
    const text = Array.from(
      { length: 100 },
      (_, index) => `line-${String(index).padStart(3, "0")}`,
    ).join("\n");

    const lines = renderConversationBodyLinesForDisplay(text, 80);

    expect(lines).toContain("line-000");
    expect(lines).toContain("line-099");
    expect(lines.join("\n")).not.toContain("[truncated");
  });

  it("supports explicit conversation body caps for constrained previews", () => {
    expect(renderConversationBodyLinesForDisplay("0123456789", 20, 4)).toEqual([
      "0123",
      "[truncated 6 chars]",
    ]);
    expect(renderConversationBodyLinesForDisplay("a\nb\nc", 20, undefined, 2)).toEqual([
      "a",
      "b",
      "[truncated additional lines]",
    ]);
  });

  it("does not undercount or split emoji clusters while truncating", () => {
    expect(truncateDisplayText("A👨‍💻B", 4)).toBe("A👨‍💻B");
    expect(truncateDisplayText("✅✅", 3)).toBe("✅");
  });

  it("pads blessed-tagged display lines so shorter redraws clear stale cells", () => {
    expect(padBlessedLineForDisplay("{green-fg}ok{/green-fg}", 5)).toBe(
      "{green-fg}ok{/green-fg}   ",
    );
    expect(padBlessedLineForDisplay("中文", 5)).toBe("中文 ");
  });

  it("renders the main TUI as an exact-size framebuffer", () => {
    const state = new TuiInteractionState();
    const vm = view();
    state.syncWithView(vm.conversation, vm.loop);

    const frame = renderTuiFrame(vm, state, new Set(), { width: 96, height: 18 });

    expect(frame).toHaveLength(18);
    expect(frame.every((line) => displayWidth(line) === 96)).toBe(true);
    expect(frame.join("\n")).toContain("Messages");
    expect(frame.join("\n")).toContain("Agent Loop");
    expect(frame.join("\n")).toContain("Loop Detail");
    expect(frame.join("\n")).toContain("PTY (read only)");
  });

  it("surfaces debugger summary and structured loop detail in the visible TUI", () => {
    const state = new TuiInteractionState();
    const vm = {
      ...view(),
      loop: [
        frame("frame-ok"),
        {
          ...frame("frame-warn"),
          id: "frame-warn",
          status: "warn" as const,
          title: "invalid model output",
          detail: "## thinking\nNeed inspect\n\n## diagnostic\ninvalid_parameter_json",
        },
      ],
    };
    state.syncWithView(vm.conversation, vm.loop);

    const output = renderTuiFrame(vm, state, new Set(), {
      width: 120,
      height: 44,
    }).join("\n");

    expect(output).toContain("Agent Loop 2f 1!");
    expect(output).toContain("Sections");
    expect(output).toContain("## thinking");
    expect(output).toContain("invalid_parameter_json");
  });

  it("merges adjacent pane borders instead of drawing double vertical seams", () => {
    const state = new TuiInteractionState();
    const vm = view();
    state.syncWithView(vm.conversation, vm.loop);

    const output = renderTuiFrame(vm, state, new Set(), { width: 96, height: 18 }).join(
      "\n",
    );

    expect(output).toContain("┬");
    expect(output).toContain("├ PTY (read only)");
    expect(output).not.toContain("┐┌");
    expect(output).not.toContain("│┌");
    expect(output).not.toContain("││");
    expect(output).not.toContain("┘└");
  });

  it("keeps framebuffer output plain so blessed cannot reinterpret pane text", () => {
    const state = new TuiInteractionState();
    const vm = view();
    state.syncWithView(vm.conversation, vm.loop);

    const output = renderTuiFrame(vm, state, new Set(), {
      width: 80,
      height: 12,
    }).join("\n");

    expect(output).not.toMatch(/\{\/?(?:green|cyan|gray|yellow|red|bold)/);
    expect(output).not.toContain("\x1b[");
  });

  it("renders a selected session PTY pane that can fit the canonical viewport", () => {
    const state = new TuiInteractionState();
    const tail = Array.from(
      { length: 40 },
      (_, index) => `screen-${String(index).padStart(2, "0")}`,
    ).join("\n");
    const vm = {
      ...view(),
      sessions: [
        session("default", "2026-01-01T00:00:01Z", tail, {
          screenCols: 120,
          screenRows: 40,
        }),
      ],
    };
    state.syncWithView(vm.conversation, vm.loop);

    const frame = renderTuiFrame(vm, state, new Set(), {
      width: 150,
      height: 51,
    });

    expect(frame).toHaveLength(51);
    expect(frame.every((line) => displayWidth(line) === 150)).toBe(true);
    expect(frame[9]).toContain("PTY default agent 120x40 fit");
    expect(frame[10]).toContain("screen-00");
    expect(frame[49]).toContain("screen-39");
  });

  it("renders the exact PTY viewport text supplied by the agent observation", () => {
    const state = new TuiInteractionState();
    const tail = Array.from(
      { length: 4 },
      (_, index) => `pty-line-${String(index + 6).padStart(2, "0")}`,
    ).join("\n");
    const vm = {
      ...view(),
      sessions: [
        session("default", "2026-01-01T00:00:01Z", tail, {
          screenCols: 80,
          screenRows: 4,
        }),
      ],
    };
    state.syncWithView(vm.conversation, vm.loop);

    const output = renderTuiFrame(vm, state, new Set(), {
      width: 96,
      height: 16,
    }).join("\n");

    expect(output).toContain("pty-line-06");
    expect(output).toContain("pty-line-09");
  });

  it("plans enough TUI space around the canonical PTY viewport first", () => {
    const plan = planTuiLayout({
      width: 150,
      bodyHeight: 50,
      ptyViewport: { cols: 120, rows: 40 },
    });

    expect(plan.rightWidth).toBe(122);
    expect(plan.bottomHeight).toBe(42);
    expect(plan.conversationPaneWidth).toBe(29);
    expect(plan.topHeight).toBe(8);
    expect(plan.ptyFitsViewport).toBe(true);
  });

  it("keeps PTY-first layout deterministic when terminal width is constrained", () => {
    const plan = planTuiLayout({
      width: 100,
      bodyHeight: 50,
      ptyViewport: { cols: 120, rows: 40 },
    });

    expect(plan.rightWidth).toBe(100);
    expect(plan.conversationPaneWidth).toBe(1);
    expect(plan.bottomHeight).toBe(42);
    expect(plan.ptyFitsViewport).toBe(false);
  });

  it("clips PTY viewer height before changing the canonical viewport", () => {
    const plan = planTuiLayout({
      width: 150,
      bodyHeight: 30,
      ptyViewport: { cols: 120, rows: 40 },
    });

    expect(plan.rightWidth).toBe(122);
    expect(plan.bottomHeight).toBe(30);
    expect(plan.topHeight).toBe(0);
    expect(plan.ptyFitsViewport).toBe(false);
  });

  it("falls back to the existing proportional layout without a PTY viewport", () => {
    const plan = planTuiLayout({ width: 96, bodyHeight: 17 });

    expect(plan.conversationPaneWidth).toBe(44);
    expect(plan.rightWidth).toBe(53);
    expect(plan.topHeight).toBe(8);
    expect(plan.bottomHeight).toBe(9);
    expect(plan.ptyFitsViewport).toBe(false);
  });

  it("adds trusted blessed color tags while escaping message braces", () => {
    const state = new TuiInteractionState();
    const vm = {
      ...view(),
      conversation: [
        {
          id: "msg-tags",
          kind: "agent" as const,
          messageKind: "status" as const,
          timestamp: "2026-01-01T00:00:00Z",
          text: "literal {red-fg}not color{/red-fg}",
        },
      ],
    };
    state.syncWithView(vm.conversation, vm.loop);

    const output = renderStyledTuiFrame(vm, state, new Set(), {
      width: 96,
      height: 18,
    }).join("\n");

    expect(output).toContain("{green-fg}agent [status]{/green-fg}");
    expect(output).toContain("{green-fg}ok{/green-fg}");
    expect(output).toContain("{open}red-fg{close}not color{open}/red-fg{close}");
    expect(output).not.toContain("literal {red-fg}not color{/red-fg}");
  });

  it("uses explicit conversation scroll offsets for framebuffer paging", () => {
    const state = new TuiInteractionState();
    const vm = {
      ...view(),
      conversation: [
        {
          id: "msg-long",
          kind: "agent" as const,
          messageKind: "status" as const,
          timestamp: "2026-01-01T00:00:00Z",
          text: Array.from({ length: 18 }, (_, index) =>
            `conv-line-${String(index).padStart(2, "0")}`,
          ).join("\n"),
        },
      ],
    };
    state.syncWithView(vm.conversation, vm.loop);
    state.followBottom.conversation = false;

    const output = renderTuiFrame(
      vm,
      state,
      new Set(),
      { width: 96, height: 12 },
      { conversation: 5 },
    ).join("\n");

    expect(output).toContain("conv-line-04");
    expect(output).not.toContain("conv-line-00");
  });

  it("uses explicit loop scroll offsets for framebuffer paging", () => {
    const state = new TuiInteractionState();
    const vm = {
      ...view(),
      loop: Array.from({ length: 14 }, (_, index) => ({
        ...frame(`frame-${index}`),
        id: `frame-${index}`,
        stepIndex: index,
        title: `loop-row-${String(index).padStart(2, "0")}`,
      })),
    };
    state.syncWithView(vm.conversation, vm.loop);
    state.pane = "loop";
    state.followBottom.loop = false;

    const output = renderTuiFrame(
      vm,
      state,
      new Set(),
      { width: 96, height: 12 },
      { loop: 6 },
    ).join("\n");

    expect(output).toContain("step 003");
    expect(output).not.toContain("step 000");
  });
});

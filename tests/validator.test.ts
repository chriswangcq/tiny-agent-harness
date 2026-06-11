import { describe, expect, it } from "vitest";
import { createTerminalState } from "../src/terminal/state.js";
import type { TerminalState } from "../src/terminal/types.js";
import { ToolCallValidator } from "../src/tools/validator.js";
import type { InternalToolCall } from "../src/types/model.js";
import type { ToolName, TerminalToolInput } from "../src/types/tools.js";

function makeCall(
  name: ToolName,
  args: TerminalToolInput,
  overrides: Partial<InternalToolCall> = {},
): InternalToolCall {
  return {
    id: "tc-1",
    name,
    arguments: args,
    ...overrides,
  };
}

function terminal(inputSeq = 1): TerminalState {
  return createTerminalState({
    inputSeq,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
  });
}

describe("ToolCallValidator terminal input tools", () => {
  it("validates terminal_write as a terminal tool request", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: "pwd\n",
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request).toEqual({
        kind: "terminal_tool",
        toolName: "terminal_write",
        toolCallId: "tc-1",
        request: {
          kind: "terminal_write",
          expectedInputSeq: 1,
          text: "pwd\n",
        },
      });
    }
  });

  it("accepts large terminal_write heredocs because runtime pacing owns PTY input", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: `cat > app.html <<'EOF'\n${"x".repeat(8192)}\nEOF\n`,
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("allows IM replies through text-stdin", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text:
          "tiny-agent im send --from \"$TAH_IM_SELF_ENDPOINT\" --to \"$TAH_IM_USER_ENDPOINT\" --kind status --text-stdin <<'IM'\n" +
          "Done.\n" +
          "IM\n",
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("rejects IM replies that use --text shell arguments", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: "tiny-agent im send --from \"$TAH_IM_SELF_ENDPOINT\" --to \"$TAH_IM_USER_ENDPOINT\" --kind status --text 'hello'\n",
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("--text-stdin");
      expect(result.observation.message).toContain("quoted heredoc");
      expect(result.observation.message).not.toContain("reply.md");
    }
  });

  it("rejects bare capability CLI commands", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: "im send --from \"$TAH_IM_SELF_ENDPOINT\" --to \"$TAH_IM_USER_ENDPOINT\" --kind status --text-stdin <<'IM'\nDone.\nIM\n",
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("tiny-agent im");
      expect(result.observation.message).toContain("bare `im");
    }
  });

  it("rejects deprecated dist main entrypoint usage", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: "node dist/cli/main.js im send --from \"$TAH_IM_SELF_ENDPOINT\" --to \"$TAH_IM_USER_ENDPOINT\" --kind status --text-stdin <<'IM'\nDone.\nIM\n",
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("installed on PATH");
      expect(result.observation.message).toContain("tiny-agent <subcommand>");
      expect(result.observation.message).toContain("dist/cli/main.js");
    }
  });

  it("rejects stale expectedInputSeq against an injected terminal snapshot", () => {
    const result = new ToolCallValidator({ terminal: terminal(2) }).validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: "echo stale\n",
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("INPUT_SEQ_MISMATCH");
      expect(result.observation.message).toContain("terminal.inputSeq 2");
    }
  });

  it("validates terminal_key pager keys and rejects ctrl-c as a key", () => {
    const valid = new ToolCallValidator({ terminal: terminal(3) }).validate(
      makeCall("terminal_key", {
        expectedInputSeq: 3,
        key: "enter",
        waitForReturnMs: 100,
      }),
    );
    expect(valid.status).toBe("valid");
    if (valid.status === "valid") {
      expect(valid.request.request).toEqual({
        kind: "terminal_key",
        expectedInputSeq: 3,
        key: "enter",
        waitForReturnMs: 100,
      });
    }

    for (const key of ["space", "q"] as const) {
      const pagerKey = new ToolCallValidator({ terminal: terminal(3) }).validate(
        makeCall("terminal_key", {
          expectedInputSeq: 3,
          key,
        }),
      );
      expect(pagerKey.status).toBe("valid");
      if (pagerKey.status === "valid") {
        expect(pagerKey.request.request).toMatchObject({
          kind: "terminal_key",
          key,
        });
      }
    }

    const invalid = new ToolCallValidator().validate(
      makeCall("terminal_key", {
        expectedInputSeq: 1,
        key: "ctrl-c" as any,
      }),
    );
    expect(invalid.status).toBe("invalid");
    if (invalid.status === "invalid") {
      expect(invalid.observation.message).toContain("session_interrupt");
      expect(invalid.observation.message).toContain("space");
      expect(invalid.observation.message).toContain("q");
    }
  });

  it("rejects session arguments on current-session input tools", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        expectedInputSeq: 1,
        text: "pwd\n",
        session: "other",
      } as any),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain('unexpected argument "session"');
    }
  });
});

describe("ToolCallValidator session tools", () => {
  it("validates session_observe and session_list", () => {
    const observe = new ToolCallValidator().validate(
      makeCall("session_observe", { session: "tests", startLine: 12, lineCount: 8 }),
    );
    expect(observe.status).toBe("valid");
    if (observe.status === "valid") {
      expect(observe.request.request).toEqual({
        kind: "session_observe",
        session: "tests",
        startLine: 12,
        lineCount: 8,
      });
    }

    const list = new ToolCallValidator().validate(makeCall("session_list", {}));
    expect(list.status).toBe("valid");
    if (list.status === "valid") {
      expect(list.request.request).toEqual({ kind: "session_list" });
    }
  });

  it("rejects invalid session_observe paging arguments", () => {
    const negativeStart = new ToolCallValidator().validate(
      makeCall("session_observe", { startLine: -1 } as any),
    );
    expect(negativeStart.status).toBe("invalid");
    if (negativeStart.status === "invalid") {
      expect(negativeStart.observation.message).toContain("startLine");
    }

    const zeroLineCount = new ToolCallValidator().validate(
      makeCall("session_observe", { lineCount: 0 } as any),
    );
    expect(zeroLineCount.status).toBe("invalid");
    if (zeroLineCount.status === "invalid") {
      expect(zeroLineCount.observation.message).toContain("positive integer");
    }
  });

  it("validates session_focus with explicit session and optional cwd", () => {
    const result = new ToolCallValidator().validate(
      makeCall("session_focus", {
        session: "build",
        create: true,
        cwd: "/repo",
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.request).toEqual({
        kind: "session_focus",
        session: "build",
        create: true,
        cwd: "/repo",
      });
    }
  });

  it("validates session_interrupt against the current session only", () => {
    const result = new ToolCallValidator({ terminal: terminal(4) }).validate(
      makeCall("session_interrupt", {
        expectedInputSeq: 4,
        waitForReturnMs: 50,
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.request).toEqual({
        kind: "session_interrupt",
        expectedInputSeq: 4,
        waitForReturnMs: 50,
      });
    }
  });

  it("validates restart and terminate with optional target session", () => {
    const restart = new ToolCallValidator().validate(
      makeCall("session_restart", {
        session: "dev",
        cwd: "/repo",
        reason: "recover unsynced prompt",
      }),
    );
    expect(restart.status).toBe("valid");
    if (restart.status === "valid") {
      expect(restart.request.request).toEqual({
        kind: "session_restart",
        session: "dev",
        cwd: "/repo",
        reason: "recover unsynced prompt",
      });
    }

    const terminate = new ToolCallValidator().validate(
      makeCall("session_terminate", {
        reason: "done",
      }),
    );
    expect(terminate.status).toBe("valid");
    if (terminate.status === "valid") {
      expect(terminate.request.request).toEqual({
        kind: "session_terminate",
        reason: "done",
      });
    }
  });

  it("rejects malformed session arguments", () => {
    const focus = new ToolCallValidator().validate(
      makeCall("session_focus", {
        session: "",
      } as any),
    );
    expect(focus.status).toBe("invalid");

    const list = new ToolCallValidator().validate(
      makeCall("session_list", { session: "nope" } as any),
    );
    expect(list.status).toBe("invalid");
    if (list.status === "invalid") {
      expect(list.observation.message).toContain('unexpected argument "session"');
    }
  });
});

describe("ToolCallValidator tool names", () => {
  it("rejects non-object tool arguments", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "terminal_write",
      arguments: null as any,
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("expected an object payload");
    }
  });

  it("rejects removed terminal side-channel tool names", () => {
    for (const name of [["ba", "sh"].join(""), ["stash", "_file"].join("")]) {
      const result = new ToolCallValidator().validate({
        id: "tc-1",
        name: name as any,
        arguments: { expectedInputSeq: 1, text: "pwd\n" } as any,
      });

      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.observation.message).toContain(`Unknown tool "${name}"`);
        expect(result.observation.message).toContain("terminal_write");
        expect(result.observation.message).not.toContain(
          `Available tools are "${["ba", "sh"].join("")}"`,
        );
      }
    }
  });

  it("rejects removed action-shaped payloads on terminal_write", () => {
    const result = new ToolCallValidator().validate(
      makeCall("terminal_write", {
        kind: ["write", "_text"].join(""),
        expectedInputSeq: 1,
        text: "pwd\n",
      } as any),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain('unexpected argument "kind"');
    }
  });
});

import { describe, expect, it } from "vitest";
import { ToolCallValidator } from "../src/tools/validator.js";
import type { InternalToolCall } from "../src/types/model.js";
import { createTerminalState } from "../src/terminal/state.js";
import type { TerminalState } from "../src/terminal/types.js";

function makeCall(
  overrides: Partial<InternalToolCall> & { arguments: InternalToolCall["arguments"] },
): InternalToolCall {
  return {
    id: "tc-1",
    name: "bash",
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

describe("ToolCallValidator PTY actions", () => {
  it("validates write_text actions as pty_action requests", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "pwd",
        },
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request).toMatchObject({
        kind: "pty_action",
        toolName: "bash",
        toolCallId: "tc-1",
        action: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "pwd",
        },
      });
    }
  });

  it("validates long write_text actions as ordinary PTY text", () => {
    const result = new ToolCallValidator({ terminal: terminal(3) }).validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 3,
          text: "hello".repeat(2000),
        },
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.kind).toBe("pty_action");
      if (result.request.kind === "pty_action") {
        expect(result.request.action.kind).toBe("write_text");
      }
    }
  });

  it("accepts long write_text payloads because PTY writes are not harness-limited", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "hello".repeat(2000),
        },
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("rejects large heredoc payloads and points to stash_file", () => {
    const heredoc = `cat > app.html <<'EOF'\n${"x".repeat(4097)}\nEOF\n`;
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: heredoc,
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("heredoc payload");
      expect(result.observation.message).toContain("stash_file");
      expect(result.observation.message).toContain("file materialize");
    }
  });

  it("allows small quoted heredoc snippets", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "cat > note.txt <<'EOF'\nhello\nEOF\n",
        },
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("allows simple quoted heredocs for im send text-stdin replies", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text:
            "node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'\n" +
            "Done.\n" +
            "IM\n",
        },
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("rejects large im send heredoc replies and points to reply file redirection", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text:
            "node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'\n" +
            `${"x".repeat(8192)}\n` +
            "IM\n",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("IM heredoc payload");
      expect(result.observation.message).toContain("simple phrase limit");
      expect(result.observation.message).toContain("< reply.md");
    }
  });

  it("rejects multiline im send heredoc replies even when under the byte limit", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text:
            "node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'\n" +
            "one\n" +
            "two\n" +
            "three\n" +
            "four\n" +
            "five\n" +
            "six\n" +
            "seven\n" +
            "IM\n",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("IM heredoc payload");
      expect(result.observation.message).toContain("simple phrase limit");
    }
  });

  it("rejects agent im send --text replies and points to text-stdin", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text:
            "node dist/cli/main.js im send --channel default --kind status --text 'hello'\n",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("--text-stdin");
      expect(result.observation.message).toContain("simple short phrases");
      expect(result.observation.message).toContain("< reply.md");
    }
  });

  it("rejects stale input sequences when terminal context is injected", () => {
    const result = new ToolCallValidator({ terminal: terminal(2) }).validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "echo stale",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("INPUT_SEQ_MISMATCH");
    }
  });

  it("accepts inputSeq-guarded writes when terminal context is injected", () => {
    const result = new ToolCallValidator({ terminal: terminal(3) }).validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedInputSeq: 3,
          text: "pwd\n",
        },
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("rejects unknown PTY action kinds", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "paste_text",
          expectedInputSeq: 1,
          text: "hello",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("unknown PTY action kind");
    }
  });

  it("rejects command-shaped bash arguments", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: { session: "default", command: "pwd" } as any,
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("payload must be a PTY action object");
      expect(result.observation.message).toContain("write_text");
    }
  });

  it("rejects control-shaped bash arguments", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: { control: "paste", session: "s1", input: "yes\n" } as any,
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("payload must be a PTY action object");
    }
  });
});

describe("ToolCallValidator tool names", () => {
  it("validates stash_file calls and defaults encoding to utf8", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "stash_file",
      arguments: {
        name: "snake.html",
        content: "<!doctype html>\n",
        description: "generated game",
      },
    });

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request).toEqual({
        kind: "stash_file",
        toolName: "stash_file",
        toolCallId: "tc-1",
        name: "snake.html",
        content: "<!doctype html>\n",
        encoding: "utf8",
        description: "generated game",
      });
    }
  });

  it("rejects invalid stash_file encoding", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "stash_file",
      arguments: {
        content: "abc",
        encoding: "hex",
      } as any,
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("encoding");
    }
  });

  it("does not validate base64 content in the model-facing validator", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "stash_file",
      arguments: {
        content: "not valid!",
        encoding: "base64",
      },
    });

    expect(result.status).toBe("valid");
  });

  it("rejects non-object tool arguments", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "stash_file",
      arguments: null as any,
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("expected an object payload");
    }
  });

  it("rejects unknown tools", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "python" as any,
      arguments: { kind: "write_text", expectedInputSeq: 1, text: "pwd" } as any,
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/Unknown tool/);
      expect(result.observation.message).toContain("stash_file");
    }
  });
});

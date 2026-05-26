import { describe, it, expect } from "vitest";
import { ToolCallValidator } from "../src/tools/validator.js";
import type { InternalToolCall } from "../src/types/model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(overrides: Partial<InternalToolCall> & { arguments: InternalToolCall["arguments"] }): InternalToolCall {
  return {
    id: "tc-1",
    name: "bash",
    ...overrides,
  };
}

const validator = new ToolCallValidator();

// ===========================================================================
// Valid cases
// ===========================================================================

describe("ToolCallValidator valid inputs", () => {
  it("valid command input with session + command", () => {
    const result = validator.validate(
      makeCall({
        arguments: { session: "default", command: "echo hello" },
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.kind).toBe("command");
      if (result.request.kind === "command") {
        expect(result.request.session).toBe("default");
        expect(result.request.command).toBe("echo hello");
        expect(result.request.timeoutMs).toBe(30_000);
      }
    }
  });

  it("valid command input with custom timeout", () => {
    const result = validator.validate(
      makeCall({
        arguments: { session: "s1", command: "sleep 10", timeoutMs: 60000 },
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "command") {
      expect(result.request.timeoutMs).toBe(60000);
    }
  });

  it("defaults omitted command session to default", () => {
    const result = validator.validate(
      makeCall({
        arguments: { command: "pwd" } as any,
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "command") {
      expect(result.request.session).toBe("default");
      expect(result.request.command).toBe("pwd");
    }
  });

  it("defaults empty command session to default", () => {
    const result = validator.validate(
      makeCall({
        arguments: { session: "", command: "echo hi" },
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "command") {
      expect(result.request.session).toBe("default");
      expect(result.request.command).toBe("echo hi");
    }
  });

  it("valid list control (no session needed)", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "list" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.kind).toBe("control");
      if (result.request.kind === "control") {
        expect(result.request.control).toBe("list");
      }
    }
  });

  it("valid create control with session", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "create", session: "my-session" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("create");
      expect(result.request.session).toBe("my-session");
    }
  });

  it("valid status control", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "status", session: "s1" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("status");
    }
  });

  it("valid poll control", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "poll", session: "s1" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("poll");
    }
  });

  it("valid interrupt control", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "interrupt", session: "s1" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("interrupt");
    }
  });

  it("valid terminate control", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "terminate", session: "s1" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("terminate");
    }
  });

  it("valid restart control", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "restart", session: "s1" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("restart");
    }
  });

  it("valid sendInput control with session + input", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "sendInput", session: "s1", input: "yes\n" } as any,
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.request.kind === "control") {
      expect(result.request.control).toBe("sendInput");
      expect(result.request.input).toBe("yes\n");
    }
  });

  it("valid stash_file input defaults encoding to utf8", () => {
    const result = validator.validate(
      makeCall({
        name: "stash_file",
        arguments: {
          name: "snake.html",
          content: "<!DOCTYPE html>",
          description: "generated game",
        },
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request).toEqual({
        kind: "stash_file",
        toolName: "stash_file",
        toolCallId: "tc-1",
        name: "snake.html",
        content: "<!DOCTYPE html>",
        encoding: "utf8",
        description: "generated game",
      });
    }
  });

  it("valid stash_file input accepts base64 bytes", () => {
    const result = validator.validate(
      makeCall({
        name: "stash_file",
        arguments: {
          content: "aGVsbG8=",
          encoding: "base64",
        },
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.kind).toBe("stash_file");
      if (result.request.kind === "stash_file") {
        expect(result.request.encoding).toBe("base64");
      }
    }
  });
});

// ===========================================================================
// Invalid cases
// ===========================================================================

describe("ToolCallValidator invalid inputs", () => {
  it("invalid: missing command on command input", () => {
    const result = validator.validate(
      makeCall({
        arguments: { session: "default", command: "" },
      }),
    );
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/command/i);
    }
  });

  it("invalid: unknown tool name (not bash)", () => {
    const result = validator.validate({
      id: "tc-1",
      name: "bash",
      arguments: { session: "default", command: "echo hi" },
    });
    // This one is valid because name is bash. Let's test with a non-bash name.
    const result2 = validator.validate({
      id: "tc-1",
      name: "python" as any,
      arguments: { session: "default", command: "echo hi" } as any,
    });
    expect(result2.status).toBe("invalid");
    if (result2.status === "invalid") {
      expect(result2.observation.message).toMatch(/Unknown tool/);
    }
  });

  it("invalid: command input missing command", () => {
    const result = validator.validate(
      makeCall({
        arguments: { session: "", command: "" },
      }),
    );
    expect(result.status).toBe("invalid");
  });

  it("invalid: create control missing session", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "create", session: "" } as any,
      }),
    );
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/session/i);
    }
  });

  it("invalid: sendInput control missing input", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "sendInput", session: "s1" } as any,
      }),
    );
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/input/i);
    }
  });

  it("invalid: session control missing session", () => {
    const result = validator.validate(
      makeCall({
        arguments: { control: "status", session: "" } as any,
      }),
    );
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/session/i);
    }
  });

  it("invalid: stash_file content must be a string", () => {
    const result = validator.validate(
      makeCall({
        name: "stash_file",
        arguments: { content: 123 } as any,
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/content/i);
    }
  });

  it("invalid: stash_file encoding is constrained", () => {
    const result = validator.validate(
      makeCall({
        name: "stash_file",
        arguments: { content: "hello", encoding: "hex" } as any,
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/encoding/i);
    }
  });
});

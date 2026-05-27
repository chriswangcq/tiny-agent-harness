import { describe, expect, it } from "vitest";
import { ToolCallValidator } from "../src/tools/validator.js";
import type { InternalToolCall } from "../src/types/model.js";
import type { TerminalOwner } from "../src/terminal/types.js";

function makeCall(
  overrides: Partial<InternalToolCall> & { arguments: InternalToolCall["arguments"] },
): InternalToolCall {
  return {
    id: "tc-1",
    name: "bash",
    ...overrides,
  };
}

function shell(revision = 1): TerminalOwner {
  return {
    kind: "shell",
    revision,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
    promptNonce: "nonce",
  };
}

function receiver(revision = 3): TerminalOwner {
  return {
    kind: "receiver",
    revision,
    receiverId: "rx-1",
    commandLine: "receiver start",
    mode: "base64",
    nextSeq: 0,
    bytesReceived: 0,
    maxFrameBytes: 4096,
  };
}

describe("ToolCallValidator PTY actions", () => {
  it("validates write_text actions as pty_action requests", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedOwnerRevision: 1,
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
          expectedOwnerRevision: 1,
          text: "pwd",
        },
      });
    }
  });

  it("validates receiver frame actions", () => {
    const result = new ToolCallValidator({ terminalOwner: receiver() }).validate(
      makeCall({
        arguments: {
          kind: "input_frame",
          expectedOwnerRevision: 3,
          receiverId: "rx-1",
          seq: 0,
          dataBase64: Buffer.from("hello").toString("base64"),
        },
      }),
    );

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.request.kind).toBe("pty_action");
      if (result.request.kind === "pty_action") {
        expect(result.request.action.kind).toBe("input_frame");
      }
    }
  });

  it("rejects oversized direct text with receiver-frame guidance", () => {
    const result = new ToolCallValidator({ actionLimits: { maxWriteTextBytes: 4 } }).validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedOwnerRevision: 1,
          text: "hello",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("PTY small-input limit");
      expect(result.observation.message).toContain("input_frame");
      expect(result.observation.message).not.toContain("stash_file");
    }
  });

  it("rejects stale owner revisions when owner context is injected", () => {
    const result = new ToolCallValidator({ terminalOwner: shell(2) }).validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedOwnerRevision: 1,
          text: "echo stale",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("OWNER_MISMATCH");
    }
  });

  it("rejects owner/action mismatches when owner context is injected", () => {
    const result = new ToolCallValidator({ terminalOwner: receiver() }).validate(
      makeCall({
        arguments: {
          kind: "write_text",
          expectedOwnerRevision: 3,
          text: "pwd",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("OWNER_REJECTED");
    }
  });

  it("rejects invalid receiver frame base64", () => {
    const result = new ToolCallValidator().validate(
      makeCall({
        arguments: {
          kind: "input_frame",
          expectedOwnerRevision: 1,
          receiverId: "rx-1",
          seq: 0,
          dataBase64: "not base64",
        },
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("valid base64");
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
  it("rejects unknown tools", () => {
    const result = new ToolCallValidator().validate({
      id: "tc-1",
      name: "python" as any,
      arguments: { kind: "write_text", expectedOwnerRevision: 1, text: "pwd" } as any,
    });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toMatch(/Unknown tool/);
    }
  });
});

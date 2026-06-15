import { describe, it, expect } from "vitest";
import {
  ENVIRONMENT_EVENT_LEVELS,
  environmentEventLevel,
  ioWaitMinLevel,
  validateIoWaitRequest,
} from "../src/types/environment.js";
import type { UserMessage } from "../src/types/environment.js";
import { STATIC_TOOL_CATALOG } from "../src/tools/catalog.js";
import { ToolCallValidator } from "../src/tools/validator.js";
import type { InternalToolCall } from "../src/types/model.js";

// P027 IM CLI Contract Audit Tests

const FIXED_TS = "2026-06-01T00:00:00.000Z";

function makeUserMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: "msg-001",
    channel: "default",
    role: "user",
    text: "fix the test",
    createdAt: FIXED_TS,
    ...overrides,
  };
}

describe("P027 IM CLI Contract", () => {
  // -- user_message_received MUST be priority 100 --
  it("user_message_received defaults to level USER_MESSAGE (100)", () => {
    const event = {
      id: "env-x",
      kind: "user_message_received" as const,
      source: "im" as const,
      timestamp: FIXED_TS,
      message: makeUserMessage(),
    };
    expect(environmentEventLevel(event)).toBe(100);
  });

  it("user_message_received level is floored at 100 even with lower level", () => {
    expect(environmentEventLevel({
      level: 1,
      id: "e", kind: "user_message_received" as const, source: "im" as const,
      timestamp: FIXED_TS, message: makeUserMessage(),
    })).toBe(100);
  });

  // -- io_wait priority-only semantics --
  it("default io_wait minLevel is MEANINGFUL (10), satisfied by user message (100)", () => {
    expect(ioWaitMinLevel({})).toBe(10);
    const event = {
      id: "e", kind: "user_message_received" as const, source: "im" as const,
      timestamp: FIXED_TS, message: makeUserMessage(),
    };
    expect(environmentEventLevel(event)).toBeGreaterThanOrEqual(ioWaitMinLevel({}));
  });

  it("validateIoWaitRequest: NaN minLevel is rejected", () => {
    expect(validateIoWaitRequest({ minLevel: NaN })).toContain("finite number");
    expect(validateIoWaitRequest({ minLevel: 10 })).toBeUndefined();
  });

  // -- No provider-native tools --
  it("STATIC_TOOL_CATALOG contains only terminal/session tools", () => {
    const names = STATIC_TOOL_CATALOG.map(t => t.name).sort();
    expect(names).toEqual([
      "session_focus", "session_interrupt", "session_list",
      "session_observe", "session_restart", "session_terminate",
      "terminal_key", "terminal_write",
    ].sort());
  });

  it("io_wait is NOT in STATIC_TOOL_CATALOG", () => {
    expect(STATIC_TOOL_CATALOG.some(t => t.name === "io_wait")).toBe(false);
  });

  // -- tiny-agent im send --text-stdin audit boundary (real validator) --
  const validator = new ToolCallValidator();

  function makeImSendWrite(text: string): InternalToolCall {
    return {
      id: "call-1",
      name: "terminal_write",
      arguments: { text, expectedInputSeq: 1 },
    };
  }

  it("terminal_write 'tiny-agent im send --text ...' is INVALID (must use --text-stdin)", () => {
    const call = makeImSendWrite(
      `tiny-agent im send --kind status --text "hello"\n`
    );
    const result = validator.validate(call);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.observation.message).toContain("--text-stdin");
    }
  });

  it("terminal_write 'tiny-agent im send --text-stdin' is VALID", () => {
    const call = makeImSendWrite(
      `tiny-agent im send --kind status --text-stdin <<'IM'\nreport\nIM\n`
    );
    const result = validator.validate(call);
    expect(result.status).toBe("valid");
  });

  it("terminal_write without im send is VALID", () => {
    const call = makeImSendWrite(`echo hello\n`);
    const result = validator.validate(call);
    expect(result.status).toBe("valid");
  });

  // -- Level constants --
  it("USER_MESSAGE > MEANINGFUL", () => {
    expect(ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE).toBe(100);
    expect(ENVIRONMENT_EVENT_LEVELS.MEANINGFUL).toBe(10);
    expect(ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE).toBeGreaterThan(ENVIRONMENT_EVENT_LEVELS.MEANINGFUL);
  });
});

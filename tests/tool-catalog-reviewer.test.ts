import { describe, expect, it } from "vitest";
import {
  SESSION_FOCUS_TOOL_DEFINITION,
  SESSION_INTERRUPT_TOOL_DEFINITION,
  SESSION_LIST_TOOL_DEFINITION,
  SESSION_OBSERVE_TOOL_DEFINITION,
  SESSION_RESTART_TOOL_DEFINITION,
  SESSION_TERMINATE_TOOL_DEFINITION,
  STATIC_TOOL_CATALOG,
  TERMINAL_KEY_TOOL_DEFINITION,
  TERMINAL_WRITE_TOOL_DEFINITION,
} from "../src/tools/catalog.js";
import { AlwaysApproveReviewer } from "../src/tools/reviewer.js";
import type { ToolRequest } from "../src/types/tools.js";

type ObjectSchema = {
  required?: string[];
  properties?: Record<string, { enum?: string[] } & Record<string, unknown>>;
  additionalProperties?: unknown;
};

describe("static tool catalog", () => {
  it("exposes explicit terminal/session tools only", () => {
    expect(STATIC_TOOL_CATALOG.map((tool) => tool.name)).toEqual([
      "terminal_write",
      "terminal_key",
      "session_observe",
      "session_list",
      "session_focus",
      "session_interrupt",
      "session_restart",
      "session_terminate",
    ]);

    expect(STATIC_TOOL_CATALOG).toEqual([
      TERMINAL_WRITE_TOOL_DEFINITION,
      TERMINAL_KEY_TOOL_DEFINITION,
      SESSION_OBSERVE_TOOL_DEFINITION,
      SESSION_LIST_TOOL_DEFINITION,
      SESSION_FOCUS_TOOL_DEFINITION,
      SESSION_INTERRUPT_TOOL_DEFINITION,
      SESSION_RESTART_TOOL_DEFINITION,
      SESSION_TERMINATE_TOOL_DEFINITION,
    ]);
  });

  it("keeps current-session input tools guarded and session-free", () => {
    const writeSchema = TERMINAL_WRITE_TOOL_DEFINITION.inputSchema as ObjectSchema;
    const keySchema = TERMINAL_KEY_TOOL_DEFINITION.inputSchema as ObjectSchema;
    const interruptSchema = SESSION_INTERRUPT_TOOL_DEFINITION.inputSchema as ObjectSchema;

    expect(writeSchema.required).toEqual(["expectedInputSeq", "text"]);
    expect(writeSchema.properties).not.toHaveProperty("session");
    expect(writeSchema.additionalProperties).toBe(false);

    expect(keySchema.required).toEqual(["expectedInputSeq", "key"]);
    expect(keySchema.properties).not.toHaveProperty("session");
    expect(JSON.stringify(keySchema)).not.toContain("ctrl-c");
    expect(keySchema.properties?.key?.enum).toEqual([
      "enter",
      "ctrl-d",
      "escape",
      "tab",
      "space",
      "q",
      "up",
      "down",
      "left",
      "right",
    ]);
    expect(keySchema.additionalProperties).toBe(false);

    expect(interruptSchema.required).toEqual(["expectedInputSeq"]);
    expect(interruptSchema.properties).not.toHaveProperty("session");
    expect(interruptSchema.additionalProperties).toBe(false);
  });

  it("keeps session management explicit", () => {
    const focusSchema = SESSION_FOCUS_TOOL_DEFINITION.inputSchema as ObjectSchema;
    const observeSchema = SESSION_OBSERVE_TOOL_DEFINITION.inputSchema as ObjectSchema;
    const listSchema = SESSION_LIST_TOOL_DEFINITION.inputSchema as ObjectSchema;
    const restartSchema = SESSION_RESTART_TOOL_DEFINITION.inputSchema as ObjectSchema;
    const terminateSchema = SESSION_TERMINATE_TOOL_DEFINITION.inputSchema as ObjectSchema;

    expect(focusSchema.required).toEqual(["session"]);
    expect(focusSchema.properties).toHaveProperty("session");
    expect(focusSchema.properties).toHaveProperty("create");
    expect(focusSchema.properties).toHaveProperty("cwd");

    expect(observeSchema.required).toBeUndefined();
    expect(observeSchema.properties).toHaveProperty("session");

    expect(listSchema.properties).toEqual({});

    expect(restartSchema.properties).toHaveProperty("session");
    expect(restartSchema.properties).toHaveProperty("cwd");
    expect(restartSchema.properties).toHaveProperty("reason");

    expect(terminateSchema.properties).toHaveProperty("session");
    expect(terminateSchema.properties).toHaveProperty("reason");
  });

  it("does not publish removed visible-tool residue", () => {
    const serialized = JSON.stringify(STATIC_TOOL_CATALOG);

    expect(serialized).not.toContain(`"${["ba", "sh"].join("")}"`);
    expect(serialized).not.toContain(["stash", "_file"].join(""));
    expect(serialized).not.toContain(["output", "Tail"].join(""));
    expect(serialized).not.toContain(["write", "_text"].join(""));
    expect(serialized).not.toContain("\"poll\"");
  });
});

describe("AlwaysApproveReviewer", () => {
  it("approves terminal tool requests in demo mode", async () => {
    const request: ToolRequest = {
      kind: "terminal_tool",
      toolName: "terminal_write",
      toolCallId: "call-1",
      request: {
        kind: "terminal_write",
        expectedInputSeq: 0,
        text: "pwd\n",
      },
    };

    await expect(new AlwaysApproveReviewer().review(request)).resolves.toEqual({
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve",
    });
  });
});

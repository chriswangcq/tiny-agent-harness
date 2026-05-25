import { describe, expect, it } from "vitest";
import { BASH_TOOL_DEFINITION, STATIC_TOOL_CATALOG } from "../src/tools/catalog.js";
import { AlwaysApproveReviewer } from "../src/tools/reviewer.js";
import type { ToolRequest } from "../src/types/tools.js";

type SchemaVariant = {
  title?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
};

type BashInputSchema = {
  type?: unknown;
  oneOf?: SchemaVariant[];
};

describe("static tool catalog", () => {
  it("exposes bash as the only model-visible tool", () => {
    expect(STATIC_TOOL_CATALOG).toHaveLength(1);
    expect(STATIC_TOOL_CATALOG[0]).toBe(BASH_TOOL_DEFINITION);
    expect(BASH_TOOL_DEFINITION.name).toBe("bash");
    expect(BASH_TOOL_DEFINITION.description).toContain("All external actions");
  });

  it("documents all supported bash input variants in oneOf schema", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema as BashInputSchema;
    expect(schema.type).toBe("object");
    expect(schema.oneOf?.map((variant) => variant.title)).toEqual([
      "BashCommandInput",
      "BashListControlInput",
      "BashCreateControlInput",
      "BashSessionControlInput",
      "BashSendInputControlInput",
    ]);

    for (const variant of schema.oneOf ?? []) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("keeps session controls and sendInput separate in schema", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema as BashInputSchema;
    const sessionControl = schema.oneOf?.find(
      (variant) => variant.title === "BashSessionControlInput",
    );
    const sendInput = schema.oneOf?.find(
      (variant) => variant.title === "BashSendInputControlInput",
    );

    expect(sessionControl?.properties?.control).toEqual({
      enum: ["status", "poll", "interrupt", "terminate", "restart"],
    });
    expect(sendInput?.required).toEqual(["control", "session", "input"]);
    expect(sendInput?.properties?.control).toEqual({ const: "sendInput" });
  });
});

describe("AlwaysApproveReviewer", () => {
  it("approves command requests in demo mode", async () => {
    const request: ToolRequest = {
      kind: "command",
      toolName: "bash",
      toolCallId: "call-1",
      session: "default",
      command: "pwd",
      timeoutMs: 30_000,
    };

    await expect(new AlwaysApproveReviewer().review(request)).resolves.toEqual({
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve",
    });
  });

  it("approves control requests in demo mode", async () => {
    const request: ToolRequest = {
      kind: "control",
      toolName: "bash",
      toolCallId: "call-2",
      control: "list",
    };

    await expect(new AlwaysApproveReviewer().review(request)).resolves.toMatchObject({
      status: "approved",
      reviewer: "always-approve",
    });
  });
});

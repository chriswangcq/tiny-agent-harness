import { describe, expect, it } from "vitest";
import {
  BASH_TOOL_DEFINITION,
  STATIC_TOOL_CATALOG,
} from "../src/tools/catalog.js";
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
  it("exposes bash as the only model-facing tool", () => {
    expect(STATIC_TOOL_CATALOG).toHaveLength(1);
    expect(STATIC_TOOL_CATALOG[0]).toBe(BASH_TOOL_DEFINITION);
    expect(BASH_TOOL_DEFINITION.name).toBe("bash");
    expect(BASH_TOOL_DEFINITION.description).toContain("owner/revision-guarded");
    expect(BASH_TOOL_DEFINITION.description).toContain("pure PTY interface");
    expect(BASH_TOOL_DEFINITION.description).toContain("Large write_text payloads are allowed");
    expect(BASH_TOOL_DEFINITION.description).not.toContain(["rece", "iver"].join(""));
  });

  it("documents PTY actions in the bash input schema", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema as BashInputSchema;
    expect(schema.type).toBe("object");
    expect(schema.oneOf?.map((variant) => variant.title)).toEqual([
      "PtyWriteTextAction",
      "PtyKeyAction",
      "PtyPollAction",
      "PtyStatusAction",
      "PtyInterruptAction",
      "PtyTerminateAction",
      "PtyRestartAction",
    ]);

    for (const variant of schema.oneOf ?? []) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("makes owner revision explicit on write-like PTY actions", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema as BashInputSchema;
    const writeText = schema.oneOf?.find(
      (variant) => variant.title === "PtyWriteTextAction",
    );

    expect(writeText?.required).toEqual(["kind", "expectedOwnerRevision", "text"]);
    expect(writeText?.properties?.kind).toEqual({ const: "write_text" });
    expect(schema.oneOf?.some((variant) => variant.title === "PtyInputFrameAction")).toBe(false);
    expect(schema.oneOf?.some((variant) => variant.title === "PtyEndInputAction")).toBe(false);
  });

  it("does not expose command or control variants as schema titles", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema as BashInputSchema;
    const serialized = JSON.stringify(schema);

    expect(serialized).not.toContain("BashCommandInput");
    expect(serialized).not.toContain("UnsupportedControlPayload");
    expect(serialized).not.toContain(["input", "_frame"].join(""));
    expect(serialized).not.toContain(["end", "_input"].join(""));
  });
});

describe("AlwaysApproveReviewer", () => {
  it("approves PTY action requests in demo mode", async () => {
    const request: ToolRequest = {
      kind: "pty_action",
      toolName: "bash",
      toolCallId: "call-1",
      action: {
        kind: "write_text",
        expectedOwnerRevision: 0,
        text: "pwd",
      },
    };

    await expect(new AlwaysApproveReviewer().review(request)).resolves.toEqual({
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve",
    });
  });

});

import { describe, expect, it } from "vitest";
import {
  BASH_TOOL_DEFINITION,
  STASH_FILE_TOOL_DEFINITION,
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
  it("exposes bash and stash_file as model-facing tools", () => {
    expect(STATIC_TOOL_CATALOG).toHaveLength(2);
    expect(STATIC_TOOL_CATALOG[0]).toBe(BASH_TOOL_DEFINITION);
    expect(STATIC_TOOL_CATALOG[1]).toBe(STASH_FILE_TOOL_DEFINITION);
    expect(BASH_TOOL_DEFINITION.name).toBe("bash");
    expect(BASH_TOOL_DEFINITION.description).toContain("inputSeq-guarded");
    expect(BASH_TOOL_DEFINITION.description).toContain("pure PTY interface");
    expect(BASH_TOOL_DEFINITION.description).toContain("All write_text input");
    expect(BASH_TOOL_DEFINITION.description).toContain("--text-stdin");
    expect(BASH_TOOL_DEFINITION.description).toContain("quoted heredoc");
    expect(BASH_TOOL_DEFINITION.description).toContain("<<'IM'");
    expect(BASH_TOOL_DEFINITION.description).toContain("normal form");
    expect(BASH_TOOL_DEFINITION.description).toContain("< reply.md");
    expect(BASH_TOOL_DEFINITION.description).toContain("Do not manually split");
    expect(BASH_TOOL_DEFINITION.description).toContain("Do not use `im send --text`");
    expect(BASH_TOOL_DEFINITION.description).toContain("ordinary textual heredocs");
    expect(BASH_TOOL_DEFINITION.description).toContain("stash_file");
    expect(BASH_TOOL_DEFINITION.description).toContain("file materialize");
    expect(BASH_TOOL_DEFINITION.description).toContain("file cat");
    expect(BASH_TOOL_DEFINITION.description).not.toContain("<<'EOF'");
    expect(BASH_TOOL_DEFINITION.description).not.toContain("cat > path");
    expect(BASH_TOOL_DEFINITION.description).not.toContain("foreground stdin consumer");
    expect(BASH_TOOL_DEFINITION.description).not.toContain("one ctrl-d may only flush the current line");
    expect(BASH_TOOL_DEFINITION.description).not.toContain("do not send any further shell command until a prompt returns");
    expect(BASH_TOOL_DEFINITION.description).toContain("does not infer");
    expect(BASH_TOOL_DEFINITION.description).toContain("terminal.inputSeq");
    expect(BASH_TOOL_DEFINITION.description).toContain("outputTail");
    expect(BASH_TOOL_DEFINITION.description).toContain("last 2K characters");
    expect(BASH_TOOL_DEFINITION.description).not.toContain(["rece", "iver"].join(""));
    expect(BASH_TOOL_DEFINITION.description).not.toContain("small/simple generated text files");
    expect(STASH_FILE_TOOL_DEFINITION.name).toBe("stash_file");
    expect(STASH_FILE_TOOL_DEFINITION.description).toContain("without writing the workspace");
    expect(STASH_FILE_TOOL_DEFINITION.description).toContain("file materialize");
    expect(STASH_FILE_TOOL_DEFINITION.description).toContain("file cat");
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

  it("makes input sequence explicit on write-like PTY actions", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema as BashInputSchema;
    const writeText = schema.oneOf?.find(
      (variant) => variant.title === "PtyWriteTextAction",
    );

    expect(writeText?.required).toEqual(["kind", "expectedInputSeq", "text"]);
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
        expectedInputSeq: 0,
        text: "pwd",
      },
    };

    await expect(new AlwaysApproveReviewer().review(request)).resolves.toEqual({
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve",
    });
  });

  it("approves stash_file requests in demo mode", async () => {
    const request: ToolRequest = {
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-1",
      name: "snake.html",
      content: "<!doctype html>\n",
      encoding: "utf8",
    };

    await expect(new AlwaysApproveReviewer().review(request)).resolves.toEqual({
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve",
    });
  });

});

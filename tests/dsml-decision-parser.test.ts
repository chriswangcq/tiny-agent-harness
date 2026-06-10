import { describe, expect, it } from "vitest";
import {
  THINKING_HARD_BOUNDARY_SEQUENCES,
  parseDsmlDecision,
} from "../src/model/dsml-decision-parser.js";

const DSML = "｜DSML｜";
const REMOVED_SHELL_TOOL = ["ba", "sh"].join("");
const REMOVED_ACTION_KIND = ["write", "_text"].join("");

type DsmlParam = string | number | boolean | object;

function dsmlTool(name: string, params: Record<string, DsmlParam>): string {
  const lines = Object.entries(params).map(([key, value]) => {
    if (typeof value === "string") {
      return `<${DSML}parameter name="${key}" string="true">${value}</${DSML}parameter>`;
    }
    return `<${DSML}parameter name="${key}" string="false">${JSON.stringify(value)}</${DSML}parameter>`;
  });
  return `${name}">\n${lines.join("\n")}`;
}

function dsmlTerminalWrite(params: Record<string, DsmlParam>): string {
  return dsmlTool("terminal_write", params);
}

function writeText(text: string): Record<string, DsmlParam> {
  return {
    expectedInputSeq: 0,
    text,
  };
}

function dsmlIoWait(reason: string, condition: object): string {
  return [
    `io_wait">`,
    `<${DSML}parameter name="reason" string="true">${reason}</${DSML}parameter>`,
    `<${DSML}parameter name="condition" string="false">${JSON.stringify(condition)}</${DSML}parameter>`,
  ].join("\n");
}

describe("parseDsmlDecision", () => {
  it("exports DSML dirty boundary prefixes for thinking stops", () => {
    expect(THINKING_HARD_BOUNDARY_SEQUENCES).toEqual(
      expect.arrayContaining([
        "</think>",
        "<｜DSML",
        "</｜DSML",
        "<DSML",
        "</DSML",
        "<|DSML",
        "</|DSML",
        "<tool_call",
        "</tool_call>",
        "｜tool",
      ]),
    );
  });

  it("parses standard DSML terminal_write call", () => {
    const raw = dsmlTerminalWrite(writeText("ls -la"));
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "terminal_write",
        arguments: writeText("ls -la"),
      },
    });
  });

  it("parses DSML io_wait with JSON condition", () => {
    const raw = dsmlIoWait("waiting", {
      kind: "new_user_message",
      channel: "test",
    });
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "io_wait",
        arguments: {
          reason: "waiting",
          condition: { kind: "new_user_message", channel: "test" },
        },
      },
    });
  });

  it("parses DSML io_wait without a condition as any-event wait", () => {
    const raw = [
      `io_wait">`,
      `<${DSML}parameter name="reason" string="true">waiting</${DSML}parameter>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "io_wait",
        arguments: {
          reason: "waiting",
        },
      },
    });
  });

  it("parses DSML io_wait with top-level minLevel", () => {
    const raw = [
      `io_wait">`,
      `<${DSML}parameter name="reason" string="true">waiting for important event</${DSML}parameter>`,
      `<${DSML}parameter name="minLevel" string="false">10</${DSML}parameter>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "io_wait",
        arguments: {
          reason: "waiting for important event",
          minLevel: 10,
        },
      },
    });
  });

  it("parses legacy DSML io_wait with condition minLevel", () => {
    const raw = dsmlIoWait("waiting for important session event", {
      kind: "event",
      source: "session",
      minLevel: 10,
    });

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "io_wait",
        arguments: {
          reason: "waiting for important session event",
          condition: { kind: "event", source: "session", minLevel: 10 },
        },
      },
    });
  });

  it("parses compatibility DSML io_wait with condition minLevel only", () => {
    const raw = dsmlIoWait("waiting for important event", { minLevel: 10 });

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "io_wait",
        arguments: {
          reason: "waiting for important event",
          condition: { minLevel: 10 },
        },
      },
    });
  });

  it.each([
    ["missing opening full-width bar", "</DSML｜parameter>"],
    ["ascii closing bar", "</DSML|parameter>"],
    ["ascii opening and closing bars", "</|DSML|parameter>"],
  ])("parses DSML parameters with dirty %s close tags", (_label, closeTag) => {
    const raw = [
      `io_wait">`,
      `<${DSML}parameter name="reason" string="true">等待用户${closeTag}`,
      `<${DSML}parameter name="condition" string="false">{"kind":"new_user_message"}${closeTag}`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "io_wait",
        arguments: {
          reason: "等待用户",
          condition: { kind: "new_user_message" },
        },
      },
    });
  });

  it("parses a complete DSML tool_calls frame", () => {
    const raw = [
      `<${DSML}tool_calls>`,
      `<${DSML}invoke name="terminal_write">`,
      `<${DSML}parameter name="expectedInputSeq" string="false">7</${DSML}parameter>`,
      `<${DSML}parameter name="text" string="true">pwd`,
      `</${DSML}parameter>`,
      `</${DSML}invoke>`,
      `</${DSML}tool_calls><｜end▁of▁sentence｜>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "terminal_write",
        arguments: {
          expectedInputSeq: 7,
          text: "pwd\n",
        },
      },
    });
  });

  it("strips trailing DSML close tokens echoed by the model", () => {
    const raw =
      dsmlTerminalWrite(writeText("pwd")) +
      `\n</${DSML}invoke>\n</${DSML}tool_calls><｜end▁of▁sentence｜>`;
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.decision.name).toBe("terminal_write");
    }
  });

  it("handles model repeating invoke-open prefix", () => {
    const raw =
      `<${DSML}invoke name="terminal_write">\n` +
      `<${DSML}parameter name="expectedInputSeq" string="false">0</${DSML}parameter>\n` +
      `<${DSML}parameter name="text" string="true">echo hi</${DSML}parameter>`;
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "terminal_write",
        arguments: writeText("echo hi"),
      },
    });
  });

  it("uses the last repeated invoke-open prefix", () => {
    const raw =
      `<${DSML}invoke name="session_observe">\n\n` +
      `<${DSML}invoke name="terminal_write">\n` +
      `<${DSML}parameter name="expectedInputSeq" string="false">9</${DSML}parameter>\n` +
      `<${DSML}parameter name="text" string="true">ls</${DSML}parameter>`;

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "terminal_write",
        arguments: {
          expectedInputSeq: 9,
          text: "ls",
        },
      },
    });
  });

  it("rejects DSML name with JSON body instead of parameter tags", () => {
    const raw = 'terminal_write">\n{"expectedInputSeq":0,"text":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("expected DSML parameter tags"),
      diagnostic: {
        code: "raw_json_parameters",
        severity: "error",
        recoverable: true,
      },
    });
  });

  it.each([
    "session_observe",
    "session_list",
    "session_restart",
    "session_terminate",
  ])("parses empty DSML arguments for %s", (toolName) => {
    const result = parseDsmlDecision(`${toolName}">\n\n`);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: toolName,
        arguments: {},
      },
    });
  });

  it("parses optional arguments for a tool that also allows empty arguments", () => {
    const raw = [
      `session_observe">`,
      `<${DSML}parameter name="session" string="true">default</${DSML}parameter>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "session_observe",
        arguments: { session: "default" },
      },
    });
  });

  it("keeps rejecting empty DSML arguments for required-argument tools", () => {
    const result = parseDsmlDecision(`terminal_write">\n\n`);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("expected DSML parameter tags"),
    });
  });

  it("rejects empty arguments for optional-but-not-empty-listed tools", () => {
    const result = parseDsmlDecision(`session_focus">\n\n`);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("expected DSML parameter tags"),
    });
  });

  it("rejects extra text outside DSML parameter tags", () => {
    const raw =
      dsmlTerminalWrite(writeText("pwd")) +
      "\nI will now do this.";
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("unexpected text outside"),
    });
  });

  it("rejects DSML calls missing the function-name terminator", () => {
    const raw = `<${DSML}invoke name="terminal_write\n`;
    const result = parseDsmlDecision(raw);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining('missing function name terminator `">`'),
    });
  });

  it("rejects implausibly long function names", () => {
    const raw = `${"x".repeat(51)}">\n`;
    const result = parseDsmlDecision(raw);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("invalid function name"),
    });
  });

  it("rejects non-string DSML parameters that are not valid JSON", () => {
    const raw = [
      `terminal_write">`,
      `<${DSML}parameter name="expectedInputSeq" string="false">not-json</${DSML}parameter>`,
    ].join("\n");
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining('declared string="false"'),
      diagnostic: {
        code: "invalid_parameter_json",
        details: { paramName: "expectedInputSeq" },
      },
    });
  });

  it("rejects io_wait when condition is not an object", () => {
    const raw = [
      `io_wait">`,
      `<${DSML}parameter name="reason" string="true">waiting</${DSML}parameter>`,
      `<${DSML}parameter name="condition" string="true">new_user_message</${DSML}parameter>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("io_wait arguments did not match"),
    });
  });

  it("rejects io_wait when reason is not a string", () => {
    const raw = [
      `io_wait">`,
      `<${DSML}parameter name="reason" string="false">123</${DSML}parameter>`,
      `<${DSML}parameter name="condition" string="false">{"kind":"new_user_message"}</${DSML}parameter>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("io_wait arguments did not match"),
    });
  });

  it("rejects unclosed DSML parameter tags without falling back to JSON", () => {
    const raw =
      `terminal_write">\n` +
      `<${DSML}parameter name="text" string="true">cat > snake.html << 'HTMLEOF'\n` +
      `<html></html>\nHTMLEOF\necho "OK"`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("unclosed DSML parameter tag"),
    });
  });

  it("rejects unknown DSML functions with complete parameter tags", () => {
    const raw = [
      `not_a_tool">`,
      `<${DSML}parameter name="value" string="true">x</${DSML}parameter>`,
    ].join("\n");

    const result = parseDsmlDecision(raw);

    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Unsupported function: not_a_tool"),
      diagnostic: {
        code: "unsupported_function",
        details: { name: "not_a_tool" },
      },
    });
  });

  it("rejects V3 separator format", () => {
    const raw = `${REMOVED_SHELL_TOOL}<｜tool▁sep｜>{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
      diagnostic: {
        code: "expected_v4_dsml",
      },
    });
  });

  it("rejects V3 function<sep>name format", () => {
    const raw =
      `function<｜tool▁sep｜>${REMOVED_SHELL_TOOL}\n` +
      `\`\`\`json\n{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}\n\`\`\``;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects double separator with removed shell-wrapper name", () => {
    const raw =
      `id=fim-call-1<｜tool▁sep｜>${REMOVED_SHELL_TOOL}<｜tool▁sep｜>` +
      `{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects trailing </tool_call> XML tag fallback", () => {
    const raw =
      `${REMOVED_SHELL_TOOL}<｜tool▁sep｜>{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}</tool_call>`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects tool_call prefix format without DSML or V3 separator", () => {
    const raw =
      `tool_call id=fim-call-1 name=${REMOVED_SHELL_TOOL} ` +
      `arguments={"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects raw text after V3 separator without JSON fallback", () => {
    const raw =
      `${REMOVED_SHELL_TOOL}<｜tool▁sep｜>im send --channel default --kind status --text Done`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("handles model echoing invoke-open without the DSML prefix", () => {
    const raw =
      `invoke name="terminal_write">\n` +
      `<${DSML}parameter name="expectedInputSeq" string="false">0</${DSML}parameter>\n` +
      `<${DSML}parameter name="text" string="true">pwd</${DSML}parameter>`;
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "terminal_write",
        arguments: writeText("pwd"),
      },
    });
  });

  it("handles PTY text with special characters in DSML parameters", () => {
    const raw = [
      `terminal_write">`,
      `<${DSML}parameter name="expectedInputSeq" string="false">0</${DSML}parameter>`,
      `<${DSML}parameter name="text" string="true">echo 'hello world' | grep "hello"</${DSML}parameter>`,
    ].join("\n");
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "terminal_write",
        arguments: writeText(`echo 'hello world' | grep "hello"`),
      },
    });
  });

  it("rejects removed file side-channel DSML tool calls", () => {
    const removedName = ["stash", "_file"].join("");
    const raw = [
      `${removedName}">`,
      `<${DSML}parameter name="name" string="true">snake.html</${DSML}parameter>`,
      `<${DSML}parameter name="content" string="true"><!doctype html>\n<title>Snake</title>\n</${DSML}parameter>`,
      `<${DSML}parameter name="encoding" string="true">utf8</${DSML}parameter>`,
    ].join("\n");
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining(`Unsupported function: ${removedName}`),
    });
  });

  it("rejects removed shell-wrapper DSML tool calls", () => {
    const removedName = ["ba", "sh"].join("");
    const raw = [
      `${removedName}">`,
      `<${DSML}parameter name="kind" string="true">${["write", "_text"].join("")}</${DSML}parameter>`,
      `<${DSML}parameter name="expectedInputSeq" string="false">0</${DSML}parameter>`,
      `<${DSML}parameter name="text" string="true">pwd</${DSML}parameter>`,
    ].join("\n");
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining(`Unsupported function: ${removedName}`),
    });
  });
});

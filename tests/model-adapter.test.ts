import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekFimAdapter } from "../src/model/adapter.js";
import { parseDsmlDecision } from "../src/model/adapter.js";
import { BASH_TOOL_DEFINITION } from "../src/tools/catalog.js";
import type { ModelStepContext, V4ChatMessage } from "../src/types/model.js";

const DSML = "｜DSML｜";

const MOCK_ENCODED_PREFIX =
  "<｜begin▁of▁sentence｜>System rules\n\n## Tools\n\n...\n<｜User｜>System-generated environment reminder.\nEnvironment reminder:\n[user@default] List files<｜Assistant｜><think>";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => MOCK_ENCODED_PREFIX),
}));

const BASE_CONTEXT: ModelStepContext = {
  runId: "run-test",
  stepIndex: 3,
  messages: [
    { role: "system", content: "System rules" },
    {
      role: "user",
      content:
        "System-generated environment reminder.\nEnvironment reminder:\n[user@default] List files",
    },
  ] as V4ChatMessage[],
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeAdapter(): DeepSeekFimAdapter {
  return new DeepSeekFimAdapter({
    apiKey: "test-key",
    baseUrl: "https://deepseek.example/beta",
    model: "deepseek-v4-pro",
    thinkingMaxTokens: 123,
    decisionMaxTokens: 45,
  });
}

function okFimResponse(
  text: string,
  finishReason?: string | null,
  completionTokens?: number,
): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ text, finish_reason: finishReason }],
      usage:
        completionTokens === undefined
          ? undefined
          : { completion_tokens: completionTokens },
    }),
    text: async () => "",
  } as unknown as Response;
}

function failedFimResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

function stubFimResponses(...texts: string[]) {
  const fetchMock = vi.fn();
  for (const text of texts) {
    fetchMock.mockResolvedValueOnce(okFimResponse(text));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFimResponseChunks(
  ...chunks: Array<{
    text: string;
    finishReason?: string | null;
    completionTokens?: number;
  }>
) {
  const fetchMock = vi.fn();
  for (const chunk of chunks) {
    fetchMock.mockResolvedValueOnce(
      okFimResponse(chunk.text, chunk.finishReason, chunk.completionTokens),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  if (!init || typeof init.body !== "string") {
    throw new Error(`Missing fetch body for call ${callIndex}`);
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper: build DSML tool call text
// ---------------------------------------------------------------------------

function dsmlBash(params: Record<string, string | object>): string {
  const lines = Object.entries(params).map(([key, value]) => {
    if (typeof value === "string") {
      return `<${DSML}parameter name="${key}" string="true">${value}</${DSML}parameter>`;
    }
    return `<${DSML}parameter name="${key}" string="false">${JSON.stringify(value)}</${DSML}parameter>`;
  });
  return `bash">\n${lines.join("\n")}`;
}

function dsmlIoWait(reason: string, condition: object): string {
  return [
    `io_wait">`,
    `<${DSML}parameter name="reason" string="true">${reason}</${DSML}parameter>`,
    `<${DSML}parameter name="condition" string="false">${JSON.stringify(condition)}</${DSML}parameter>`,
  ].join("\n");
}

// ===========================================================================
// Tests
// ===========================================================================

describe("DeepSeekFimAdapter", () => {
  it("runs thinking and decision FIM passes and parses a DSML bash tool call", async () => {
    const rawDecision = dsmlBash({
      session: "default",
      command: "pwd",
    });
    const fetchMock = stubFimResponses("Need inspect cwd", rawDecision);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://deepseek.example/beta/completions",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer test-key",
      }),
    });

    // Thinking pass — prefix from Python encoder, suffix is </think>
    expect(requestBody(fetchMock, 0)).toMatchObject({
      model: "deepseek-v4-pro",
      suffix: "</think>",
      max_tokens: 123,
      stop: [`<${DSML}tool_calls>`],
    });
    const thinkingPrompt = String(requestBody(fetchMock, 0).prompt);
    expect(thinkingPrompt).toBe(MOCK_ENCODED_PREFIX);

    // Decision pass — prefix includes thinking content + DSML invoke prefix
    const decisionBody = requestBody(fetchMock, 1);
    expect(decisionBody.suffix).toBe(
      `\n</${DSML}invoke>\n</${DSML}tool_calls><｜end▁of▁sentence｜>`,
    );
    expect(decisionBody.max_tokens).toBe(45);
    expect(decisionBody).not.toHaveProperty("stop");
    const decisionPrompt = String(decisionBody.prompt);
    expect(decisionPrompt).toContain(MOCK_ENCODED_PREFIX);
    expect(decisionPrompt).toContain("Need inspect cwd");
    expect(decisionPrompt).toContain(`</think>\n\n<${DSML}tool_calls>`);
    expect(decisionPrompt).toContain(`<${DSML}invoke name="`);

    // Parsed result
    expect(output.thinking.content).toBe("Need inspect cwd");
    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall).toEqual(
        expect.objectContaining({
          id: "fim-call-run-test-3",
          name: "bash",
          arguments: { session: "default", command: "pwd" },
        }),
      );
    }
  });

  it("continues FIM completions when the response hits the token limit", async () => {
    const decisionPrefix = [
      `bash">`,
      `<${DSML}parameter name="session" string="true">default</${DSML}parameter>`,
      `<${DSML}parameter name="command" string="true">ec`,
    ].join("\n");
    const decisionSuffix = `ho hi</${DSML}parameter>`;
    const fetchMock = stubFimResponseChunks(
      { text: "Need ", finishReason: "length" },
      { text: "inspect cwd", finishReason: "stop" },
      { text: decisionPrefix, finishReason: "length" },
      { text: decisionSuffix, finishReason: "stop" },
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestBody(fetchMock, 0).stop).toEqual([`<${DSML}tool_calls>`]);
    expect(requestBody(fetchMock, 1).stop).toEqual([`<${DSML}tool_calls>`]);
    expect(requestBody(fetchMock, 2)).not.toHaveProperty("stop");
    expect(requestBody(fetchMock, 3)).not.toHaveProperty("stop");
    expect(String(requestBody(fetchMock, 1).prompt)).toBe(
      `${MOCK_ENCODED_PREFIX}Need `,
    );
    expect(String(requestBody(fetchMock, 3).prompt)).toContain(decisionPrefix);

    expect(output.thinking.content).toBe("Need inspect cwd");
    expect(output.usage).toEqual({
      thinking: { finishReasons: ["length", "stop"], continuationRounds: 1 },
      decision: { finishReasons: ["length", "stop"], continuationRounds: 1 },
    });
    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall.arguments).toEqual({
        session: "default",
        command: "echo hi",
      });
    }
  });

  it("parses DSML io_wait decisions", async () => {
    const rawDecision = dsmlIoWait("need confirmation", {
      kind: "new_user_message",
      channel: "default",
    });
    stubFimResponses("Need user input", rawDecision);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn.kind).toBe("io_wait");
    if (output.turn.kind === "io_wait") {
      expect(output.turn.wait).toEqual({
        reason: "need confirmation",
        condition: { kind: "new_user_message", channel: "default" },
      });
    }
  });

  it("sanitizes thinking before injecting it into the decision prompt", async () => {
    const contaminatedThinking = [
      "Need answer in IM.",
      "</think>",
      `<${DSML}tool_calls>`,
      `bash<｜tool▁sep｜>{"session":"default","command":"pwd"}`,
      `</${DSML}tool_calls>`,
    ].join("\n");
    const fetchMock = stubFimResponses(
      contaminatedThinking,
      dsmlBash({ session: "default", command: "pwd" }),
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    const decisionPrompt = String(requestBody(fetchMock, 1).prompt);
    const injectedThinking = decisionPrompt
      .split("<｜Assistant｜><think>")
      .at(-1)!
      .split("</think>")[0]!;

    expect(output.thinking.content).toBe(contaminatedThinking);
    expect(injectedThinking).toContain("Need answer in IM.");
    expect(injectedThinking).not.toContain("</think>");
    expect(injectedThinking).not.toContain("｜DSML｜");
    expect(injectedThinking).not.toContain("｜tool");
  });

  it("rejects final decisions as unsupported", async () => {
    stubFimResponses(
      "Task is complete",
      `final">\n<${DSML}parameter name="content" string="true">done</${DSML}parameter>`,
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Unsupported"),
    });
  });

  it("rejects legacy V3 format with separator", async () => {
    stubFimResponses(
      "Thinking",
      'bash<｜tool▁sep｜>{"session":"default","command":"pwd"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects ambiguous brace-split output when DSML is missing", async () => {
    stubFimResponses(
      "Thinking",
      'bash {"session":"default","command":"pwd"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("returns invalid_output when no JSON is found in decision", async () => {
    stubFimResponses("Thinking", "I should run a command");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("returns invalid_output when decision JSON is invalid", async () => {
    stubFimResponses("Thinking", "bash<｜tool▁sep｜>{not json}");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("returns invalid_output for unsupported decision functions", async () => {
    stubFimResponses(
      "Thinking",
      `python">\n<${DSML}parameter name="code" string="true">print(1)</${DSML}parameter>`,
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Unsupported"),
    });
  });

  it("rejects legacy V3 boundary tokens with separator", async () => {
    stubFimResponses(
      "Thinking",
      '</end▁of▁sentence｜>bash<｜tool▁sep｜>{"session":"default","command":"ls"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("throws with response body when the FIM request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failedFimResponse(429, "rate limited"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeAdapter().generateTurn(BASE_CONTEXT, {
        bashTool: BASH_TOOL_DEFINITION,
      }),
    ).rejects.toThrow("DeepSeek FIM request failed: 429 rate limited");
  });

  it("throws when the FIM response has no text choice", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{}] }),
      text: async () => "",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeAdapter().generateTurn(BASE_CONTEXT, {
        bashTool: BASH_TOOL_DEFINITION,
      }),
    ).rejects.toThrow("DeepSeek FIM response missing choices[0].text");
  });

  it("passes tools to the encoder so V4 chat template conditions both FIM passes", async () => {
    const { execFileSync } = await import("node:child_process");
    const mockExec = vi.mocked(execFileSync);

    stubFimResponses(
      "thinking",
      dsmlBash({ session: "default", command: "pwd" }),
    );

    await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    const thinkingInput = JSON.parse(mockExec.mock.calls[0]![2]!.input as string);
    const thinkingSysMsg = thinkingInput.messages[0];
    expect(thinkingSysMsg.role).toBe("system");
    expect(thinkingSysMsg.tools).toHaveLength(2);
    expect(thinkingSysMsg.tools[0].function.name).toBe("bash");
    expect(thinkingSysMsg.tools[1].function.name).toBe("io_wait");
    expect(thinkingInput.thinking_mode).toBe("thinking");

    const decisionInput = JSON.parse(mockExec.mock.calls[1]![2]!.input as string);
    const decisionSysMsg = decisionInput.messages[0];
    expect(decisionSysMsg.role).toBe("system");
    expect(decisionSysMsg.tools).toHaveLength(2);
    expect(decisionSysMsg.tools[0].function.name).toBe("bash");
    expect(decisionSysMsg.tools[1].function.name).toBe("io_wait");
    expect(decisionInput.thinking_mode).toBe("thinking");
  });
});

// ===========================================================================
// parseDsmlDecision unit tests
// ===========================================================================

describe("parseDsmlDecision", () => {
  it("parses standard DSML bash call", () => {
    const raw = dsmlBash({ session: "default", command: "ls -la" });
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "bash",
        arguments: { session: "default", command: "ls -la" },
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

  it("strips trailing DSML close tokens echoed by the model", () => {
    const raw =
      dsmlBash({ session: "default", command: "pwd" }) +
      `\n</${DSML}invoke>\n</${DSML}tool_calls><｜end▁of▁sentence｜>`;
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.decision.name).toBe("bash");
    }
  });

  it("handles model repeating invoke-open prefix", () => {
    const raw =
      `<${DSML}invoke name="bash">\n` +
      `<${DSML}parameter name="session" string="true">default</${DSML}parameter>\n` +
      `<${DSML}parameter name="command" string="true">echo hi</${DSML}parameter>`;
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "bash",
        arguments: { session: "default", command: "echo hi" },
      },
    });
  });

  it("rejects DSML name with JSON body instead of parameter tags", () => {
    const raw = 'bash">\n{"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("expected DSML parameter tags"),
    });
  });

  it("rejects unclosed DSML parameter tags without falling back to JSON", () => {
    const raw =
      `bash">\n` +
      `<${DSML}parameter name="command" string="true">cat > snake.html << 'HTMLEOF'\n` +
      `<html></html>\nHTMLEOF\necho "OK"`;
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("unclosed DSML parameter tag"),
    });
  });

  it("rejects V3 separator format", () => {
    const raw = 'bash<｜tool▁sep｜>{"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects V3 function<sep>name format", () => {
    const raw =
      'function<｜tool▁sep｜>bash\n```json\n{"session":"default","command":"pwd"}\n```';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects double separator: id=...<sep>bash<sep>{json}", () => {
    const raw =
      'id=fim-call-1<｜tool▁sep｜>bash<｜tool▁sep｜>{"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects trailing </tool_call> XML tag fallback", () => {
    const raw =
      'bash<｜tool▁sep｜>{"session":"default","command":"pwd"}</tool_call>';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects tool_call prefix format without DSML or V3 separator", () => {
    const raw =
      'tool_call id=fim-call-1 name=bash arguments={"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects raw text after V3 separator instead of wrapping it as bash JSON", () => {
    const raw =
      "bash<｜tool▁sep｜>node dist/cli/main.js im send --channel default --text hello";
    const result = parseDsmlDecision(raw);
    expect(result).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("handles model echoing invoke-open without the DSML prefix", () => {
    const raw =
      `invoke name="bash">\n` +
      `<${DSML}parameter name="session" string="true">default</${DSML}parameter>\n` +
      `<${DSML}parameter name="command" string="true">pwd</${DSML}parameter>`;
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "bash",
        arguments: { session: "default", command: "pwd" },
      },
    });
  });

  it("handles commands with special characters in DSML parameters", () => {
    const raw = [
      `bash">`,
      `<${DSML}parameter name="session" string="true">default</${DSML}parameter>`,
      `<${DSML}parameter name="command" string="true">echo 'hello world' | grep "hello"</${DSML}parameter>`,
    ].join("\n");
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "bash",
        arguments: {
          session: "default",
          command: `echo 'hello world' | grep "hello"`,
        },
      },
    });
  });
});

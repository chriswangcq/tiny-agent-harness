import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekFimAdapter } from "../src/model/adapter.js";
import { STATIC_TOOL_CATALOG } from "../src/tools/catalog.js";
import type { DeepSeekFimConfig } from "../src/model/adapter.js";
import type { ModelStepContext, V4ChatMessage } from "../src/types/model.js";

const DSML = "｜DSML｜";
const REMOVED_SHELL_TOOL = ["ba", "sh"].join("");
const REMOVED_ACTION_KIND = ["write", "_text"].join("");
const EXPECTED_THINKING_STOP_SEQUENCES = [
  "</think>",
  "<｜DSML",
  "</｜DSML",
  "<DSML",
  "</DSML",
  "<|DSML",
  "</|DSML",
  `<${DSML}tool_calls>`,
  `<${DSML}invoke name="`,
  "<tool_call",
  "</tool_call>",
  "｜tool",
];

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

function makeAdapter(
  overrides: Partial<DeepSeekFimConfig> = {},
): DeepSeekFimAdapter {
  return new DeepSeekFimAdapter({
    apiKey: "test-key",
    baseUrl: "https://deepseek.example/beta",
    model: "deepseek-v4-pro",
    thinkingMaxTokens: 123,
    decisionMaxTokens: 45,
    ...overrides,
  });
}

function okFimResponse(
  text: string,
  finishReason?: string | null,
  completionTokens?: number,
): Response {
  return okFimStreamResponse([
    { text, finishReason, completionTokens },
  ]);
}

function okFimStreamResponse(
  chunks: Array<{
    text: string;
    finishReason?: string | null;
    completionTokens?: number;
    usage?: Record<string, unknown>;
  }>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [
                {
                  text: chunk.text,
                  finish_reason: chunk.finishReason,
                },
              ],
              usage:
                chunk.usage ??
                (chunk.completionTokens === undefined
                  ? null
                  : { completion_tokens: chunk.completionTokens }),
            })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function rawFimStreamResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
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

function stubFimStreamResponses(
  ...responses: Array<
    Array<{
      text: string;
      finishReason?: string | null;
      completionTokens?: number;
    }>
  >
) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(okFimStreamResponse(response));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectProgressContent(
  progress: Array<{ content: string; sequence: number }>,
  content: string,
) {
  expect(progress.map((event) => event.content).join("")).toBe(content);
  expect(progress.map((event) => event.sequence)).toEqual(
    progress.map((_, index) => index),
  );
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

// ===========================================================================
// Tests
// ===========================================================================

describe("DeepSeekFimAdapter", () => {
  it("runs thinking and decision FIM passes and parses a DSML terminal_write tool call", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = stubFimResponses("Need inspect cwd", rawDecision);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
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
      stream: true,
      stream_options: { include_usage: true },
      stop: EXPECTED_THINKING_STOP_SEQUENCES,
    });
    const thinkingPrompt = String(requestBody(fetchMock, 0).prompt);
    expect(thinkingPrompt).toBe(MOCK_ENCODED_PREFIX);

    // Decision pass — prefix includes thinking content + DSML invoke prefix
    const decisionBody = requestBody(fetchMock, 1);
    expect(decisionBody).not.toHaveProperty("suffix");
    expect(decisionBody.max_tokens).toBe(45);
    expect(decisionBody.stop).toEqual([`</${DSML}invoke>`]);
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
          name: "terminal_write",
          arguments: writeText("pwd"),
        }),
      );
    }
  });

  it("streams thinking deltas from one FIM string response", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const thinking = "Need inspect cwd carefully before choosing the next tool.";
    const fetchMock = stubFimStreamResponses(
      [
        { text: thinking.slice(0, 12), finishReason: null },
        { text: thinking.slice(12, 32), finishReason: null },
        { text: thinking.slice(32), finishReason: "stop" },
      ],
      [{ text: rawDecision, finishReason: "stop" }],
    );
    const progress: Array<{ content: string; sequence: number }> = [];

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
      onProgress(event) {
        progress.push({ content: event.content, sequence: event.sequence });
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      prompt: MOCK_ENCODED_PREFIX,
      suffix: "</think>",
      stream: true,
      stream_options: { include_usage: true },
    });
    expectProgressContent(progress, thinking);
    expect(progress.length).toBeGreaterThan(1);
    expect(output.thinking.content).toBe(thinking);
    expect(output.turn.kind).toBe("tool_call");
  });

  it("filters accidental thinking boundary markup across stream chunks", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = stubFimStreamResponses(
      [
        { text: "Need inspect", finishReason: null },
        { text: "</th", finishReason: null },
        {
          text: `ink>\n<${DSML}tool_calls>bad`,
          finishReason: "stop",
        },
      ],
      [{ text: rawDecision, finishReason: "stop" }],
    );
    const progress: Array<{ content: string; sequence: number }> = [];

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
      onProgress(event) {
        progress.push({ content: event.content, sequence: event.sequence });
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectProgressContent(progress, "Need inspect");
    expect(output.thinking.content).toBe("Need inspect");
    const decisionPrompt = String(requestBody(fetchMock, 1).prompt);
    expect(decisionPrompt).toContain("Need inspect");
    expect(decisionPrompt).not.toContain("</think>\n<");
    expect(decisionPrompt).not.toContain("bad");
  });

  it("stops thinking continuation after accidental boundary markup", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = stubFimResponseChunks(
      {
        text: `Need inspect</think>\n<${DSML}tool_calls>bad`,
        finishReason: "length",
      },
      { text: rawDecision, finishReason: "stop" },
    );
    const progress: Array<{ content: string; sequence: number }> = [];

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
      onProgress(event) {
        progress.push({ content: event.content, sequence: event.sequence });
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectProgressContent(progress, "Need inspect");
    expect(output.thinking.content).toBe("Need inspect");
    expect(requestBody(fetchMock, 1).prompt).toContain("Need inspect");
    expect(output.turn.kind).toBe("tool_call");
  });

  it.each(["<｜DSML", "</｜DSML", "<DSML", "</DSML"])(
    "filters dirty DSML frame boundary %s from final thinking content",
    async (dirtyBoundary) => {
      const rawDecision = dsmlTerminalWrite(writeText("pwd"));
      const fetchMock = stubFimStreamResponses(
        [
          { text: "Need reply", finishReason: null },
          { text: `\n\n${dirtyBoundary}`, finishReason: "stop" },
        ],
        [{ text: rawDecision, finishReason: "stop" }],
      );
      const progress: Array<{ content: string; sequence: number }> = [];

      const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
        tools: [...STATIC_TOOL_CATALOG],
        onProgress(event) {
          progress.push({ content: event.content, sequence: event.sequence });
        },
      });

      expect(requestBody(fetchMock, 0).stop).toEqual(
        EXPECTED_THINKING_STOP_SEQUENCES,
      );
      expectProgressContent(progress, "Need reply");
      expect(output.thinking.content).toBe("Need reply");
      expect(output.turn.kind).toBe("tool_call");
    },
  );

  it("parses decision DSML split across streamed chunks", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    stubFimStreamResponses(
      [{ text: "Need inspect cwd", finishReason: "stop" }],
      [
        { text: rawDecision.slice(0, 3), finishReason: null },
        { text: rawDecision.slice(3, 40), finishReason: null },
        { text: rawDecision.slice(40), finishReason: "stop" },
      ],
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall.arguments).toEqual({
        ...writeText("pwd"),
      });
    }
  });

  it("parses zero-parameter terminal session decisions", async () => {
    const rawDecision = `session_observe">\n\n`;
    stubFimStreamResponses(
      [{ text: "Need inspect terminal", finishReason: "stop" }],
      [{ text: rawDecision, finishReason: "stop" }],
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall.name).toBe("session_observe");
      expect(output.turn.toolCall.arguments).toEqual({});
    }
  });

  it("parses SSE data split across network byte chunks", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        rawFimStreamResponse([
          'data: {"choices":[{"text":"Ne',
          'ed inspect cwd","finish_reason":"stop"}],"usage":{"completion_tokens":3}}\n',
          "\n",
          "data: [DONE]\n\n",
        ]),
      )
      .mockResolvedValueOnce(okFimStreamResponse([
        { text: rawDecision, finishReason: "stop" },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.thinking.content).toBe("Need inspect cwd");
    expect(output.turn.kind).toBe("tool_call");
  });

  it("parses SSE events with multiple data lines and usage-only chunks", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        rawFimStreamResponse([
          'data: {"choices":[{"text":"Need ","finish_reason":null}],',
          "\n",
          'data: "usage":null}',
          "\n\n",
          'data: {"choices":[{"text":"inspect cwd","finish_reason":"stop"}],"usage":null}',
          "\n\n",
          'data: {"choices":[],"usage":{"completion_tokens":3}}',
          "\n\n",
          "data: [DONE]\n\n",
        ]),
      )
      .mockResolvedValueOnce(okFimStreamResponse([
        { text: rawDecision, finishReason: "stop" },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.thinking.content).toBe("Need inspect cwd");
    expect(output.usage).toMatchObject({
      thinking: { finishReasons: ["stop"], continuationRounds: 0 },
    });
    expect(output.turn.kind).toBe("tool_call");
  });

  it("preserves provider cache usage fields from FIM streams", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = stubFimStreamResponses(
      [
        {
          text: "Need inspect cwd",
          finishReason: "stop",
          usage: {
            prompt_tokens: 100,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
            completion_tokens: 3,
          },
        },
      ],
      [
        {
          text: rawDecision,
          finishReason: "stop",
          usage: {
            prompt_tokens: 120,
            prompt_cache_hit_tokens: 110,
            prompt_cache_miss_tokens: 10,
            completion_tokens: 9,
          },
        },
      ],
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.usage).toMatchObject({
      thinking: {
        usages: [
          {
            prompt_tokens: 100,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        ],
      },
      decision: {
        usages: [
          {
            prompt_tokens: 120,
            prompt_cache_hit_tokens: 110,
            prompt_cache_miss_tokens: 10,
          },
        ],
      },
    });
  });

  it("continues FIM completions when the response hits the token limit", async () => {
    const decisionPrefix = [
      `terminal_write">`,
      `<${DSML}parameter name="expectedInputSeq" string="false">0</${DSML}parameter>`,
      `<${DSML}parameter name="text" string="true">ec`,
    ].join("\n");
    const decisionSuffix = `ho hi</${DSML}parameter>`;
    const fetchMock = stubFimResponseChunks(
      { text: "Need ", finishReason: "length" },
      { text: "inspect cwd", finishReason: "stop" },
      { text: decisionPrefix, finishReason: "length" },
      { text: decisionSuffix, finishReason: "stop" },
    );
    const progress: Array<{ content: string; sequence: number }> = [];

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
      onProgress(event) {
        progress.push({ content: event.content, sequence: event.sequence });
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expectProgressContent(progress, "Need inspect cwd");
    expect(requestBody(fetchMock, 0).stop).toEqual(
      EXPECTED_THINKING_STOP_SEQUENCES,
    );
    expect(requestBody(fetchMock, 1).stop).toEqual(
      EXPECTED_THINKING_STOP_SEQUENCES,
    );
    expect(requestBody(fetchMock, 2).stop).toEqual([`</${DSML}invoke>`]);
    expect(requestBody(fetchMock, 2)).not.toHaveProperty("suffix");
    expect(requestBody(fetchMock, 3).stop).toEqual([`</${DSML}invoke>`]);
    expect(requestBody(fetchMock, 3)).not.toHaveProperty("suffix");
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
        ...writeText("echo hi"),
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
      tools: [...STATIC_TOOL_CATALOG],
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
      `${REMOVED_SHELL_TOOL}<｜tool▁sep｜>{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}`,
      `</${DSML}tool_calls>`,
    ].join("\n");
    const fetchMock = stubFimResponses(
      contaminatedThinking,
      dsmlTerminalWrite(writeText("pwd")),
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    const decisionPrompt = String(requestBody(fetchMock, 1).prompt);
    const injectedThinking = decisionPrompt
      .split("<｜Assistant｜><think>")
      .at(-1)!
      .split("</think>")[0]!;

    expect(output.thinking.content).toBe("Need answer in IM.");
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
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Unsupported"),
    });
  });

  it("rejects legacy V3 format with separator", async () => {
    stubFimResponses(
      "Thinking",
      `${REMOVED_SHELL_TOOL}<｜tool▁sep｜>{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}`,
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("rejects ambiguous brace-split output when DSML is missing", async () => {
    stubFimResponses(
      "Thinking",
      `${REMOVED_SHELL_TOOL} {"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"pwd"}`,
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("returns invalid_output when no JSON is found in decision", async () => {
    stubFimResponses("Thinking", "I should inspect the terminal output");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("returns invalid_output when decision JSON is invalid", async () => {
    stubFimResponses("Thinking", `${REMOVED_SHELL_TOOL}<｜tool▁sep｜>{not json}`);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
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
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Unsupported"),
    });
  });

  it("rejects legacy V3 boundary tokens with separator", async () => {
    stubFimResponses(
      "Thinking",
      `</end▁of▁sentence｜>${REMOVED_SHELL_TOOL}<｜tool▁sep｜>{"kind":"${REMOVED_ACTION_KIND}","expectedInputSeq":0,"text":"ls"}`,
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Expected a V4 DSML tool call"),
    });
  });

  it("throws with response body when the FIM request fails with a non-retryable status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failedFimResponse(400, "bad request"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeAdapter().generateTurn(BASE_CONTEXT, {
        tools: [...STATIC_TOOL_CATALOG],
      }),
    ).rejects.toThrow("DeepSeek FIM request failed: 400 bad request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries FIM fetch failures before a streaming response starts", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okFimResponse("Need inspect cwd"))
      .mockResolvedValueOnce(okFimResponse(rawDecision));
    vi.stubGlobal("fetch", fetchMock);

    const output = await makeAdapter({
      requestRetryInitialDelayMs: 0,
    }).generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(output.turn.kind).toBe("tool_call");
  });

  it("retries retryable FIM HTTP statuses before reading the stream", async () => {
    const rawDecision = dsmlTerminalWrite(writeText("pwd"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failedFimResponse(429, "rate limited"))
      .mockResolvedValueOnce(failedFimResponse(502, "bad gateway"))
      .mockResolvedValueOnce(okFimResponse("Need inspect cwd"))
      .mockResolvedValueOnce(okFimResponse(rawDecision));
    vi.stubGlobal("fetch", fetchMock);

    const output = await makeAdapter({
      requestRetryInitialDelayMs: 0,
    }).generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(output.turn.kind).toBe("tool_call");
  });

  it("stops retrying after the configured FIM request attempt limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(failedFimResponse(500, "server error"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeAdapter({
        requestRetryInitialDelayMs: 0,
        requestRetryMaxAttempts: 2,
      }).generateTurn(BASE_CONTEXT, {
        tools: [...STATIC_TOOL_CATALOG],
      }),
    ).rejects.toThrow(
      "DeepSeek FIM request failed: 500 server error (after 2 attempts)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the FIM response has no text choice", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{}]}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: stream,
      text: async () => "",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeAdapter().generateTurn(BASE_CONTEXT, {
        tools: [...STATIC_TOOL_CATALOG],
      }),
    ).rejects.toThrow("DeepSeek FIM stream chunk missing choices[0].text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes tools to the encoder so V4 chat template conditions both FIM passes", async () => {
    const { execFileSync } = await import("node:child_process");
    const mockExec = vi.mocked(execFileSync);

    stubFimResponses(
      "thinking",
      dsmlTerminalWrite(writeText("pwd")),
    );

    await makeAdapter().generateTurn(BASE_CONTEXT, {
      tools: [...STATIC_TOOL_CATALOG],
    });

    const thinkingInput = JSON.parse(mockExec.mock.calls[0]![2]!.input as string);
    const thinkingSysMsg = thinkingInput.messages[0];
    expect(thinkingSysMsg.role).toBe("system");
    expect(thinkingSysMsg.tools.map((tool: any) => tool.function.name)).toEqual([
      "terminal_write",
      "terminal_key",
      "session_observe",
      "session_list",
      "session_focus",
      "session_interrupt",
      "session_restart",
      "session_terminate",
      "io_wait",
    ]);
    expect(thinkingInput.thinking_mode).toBe("thinking");

    const decisionInput = JSON.parse(mockExec.mock.calls[1]![2]!.input as string);
    const decisionSysMsg = decisionInput.messages[0];
    expect(decisionSysMsg.role).toBe("system");
    expect(decisionSysMsg.tools.map((tool: any) => tool.function.name)).toEqual([
      "terminal_write",
      "terminal_key",
      "session_observe",
      "session_list",
      "session_focus",
      "session_interrupt",
      "session_restart",
      "session_terminate",
      "io_wait",
    ]);
    expect(decisionInput.thinking_mode).toBe("thinking");
  });
});

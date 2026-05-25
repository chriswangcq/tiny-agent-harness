import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekFimAdapter } from "../src/model/adapter.js";
import { BASH_TOOL_DEFINITION } from "../src/tools/catalog.js";
import type { ModelStepContext } from "../src/types/model.js";

const BASE_CONTEXT: ModelStepContext = {
  runId: "run-test",
  stepIndex: 3,
  messages: [
    { role: "system", content: "System rules" },
    { role: "user", content: "List files" },
    { role: "observation", content: "{\"returnCode\":0}" },
  ],
};

function makeAdapter(): DeepSeekFimAdapter {
  return new DeepSeekFimAdapter({
    apiKey: "test-key",
    baseUrl: "https://deepseek.example/beta",
    model: "deepseek-v4-pro",
    thinkingMaxTokens: 123,
    decisionMaxTokens: 45,
  });
}

function okFimResponse(text: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ text }] }),
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

describe("DeepSeekFimAdapter", () => {
  it("runs thinking and decision FIM passes and parses a native bash tool call", async () => {
    const rawDecision =
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>bash<｜tool▁sep｜>{"session":"default","command":"pwd","timeoutMs":1000}<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜>';
    const fetchMock = stubFimResponses("Need inspect cwd", rawDecision);

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://deepseek.example/beta/completions");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer test-key",
      }),
    });

    expect(requestBody(fetchMock, 0)).toMatchObject({
      model: "deepseek-v4-pro",
      suffix: "</think>",
      max_tokens: 123,
    });
    expect(String(requestBody(fetchMock, 0).prompt)).toContain("<｜Assistant｜><think>");

    expect(requestBody(fetchMock, 1)).toMatchObject({
      model: "deepseek-v4-pro",
      suffix: "<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜>",
      max_tokens: 45,
    });
    const decisionPrompt = String(requestBody(fetchMock, 1).prompt);
    expect(decisionPrompt).toContain("</think>");
    expect(decisionPrompt).toContain("<｜tool▁calls▁begin｜>");
    expect(decisionPrompt).toContain("<｜tool▁call▁begin｜>");
    expect(decisionPrompt).toContain("Decision output format: function_name<｜tool▁sep｜>");

    expect(output.thinking.content).toBe("Need inspect cwd");
    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall).toEqual(
        expect.objectContaining({
          id: "fim-call-run-test-3",
          name: "bash",
          arguments: {
            session: "default",
            command: "pwd",
            timeoutMs: 1000,
          },
        }),
      );
    }
  });

  it("parses final decisions", async () => {
    stubFimResponses(
      "Task is complete",
      'final<｜tool▁sep｜>{"content":"done"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "final",
      content: "done",
      rawDecision: 'final<｜tool▁sep｜>{"content":"done"}',
    });
  });

  it("parses io_wait decisions", async () => {
    stubFimResponses(
      "Need user input",
      'io_wait<｜tool▁sep｜>{"reason":"need confirmation","condition":{"kind":"new_user_message","channel":"default"}}',
    );

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

  it("returns invalid_output when the native tool separator is missing", async () => {
    stubFimResponses("Thinking", "bash {\"session\":\"default\"}");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: "FIM decision did not contain DeepSeek native tool separator.",
    });
  });

  it("returns invalid_output when decision JSON is invalid", async () => {
    stubFimResponses("Thinking", "bash<｜tool▁sep｜>{not json}");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: "FIM native tool decision arguments were not valid JSON.",
    });
  });

  it("returns invalid_output for unsupported decision functions", async () => {
    stubFimResponses("Thinking", 'python<｜tool▁sep｜>{"code":"print(1)"}');

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: "Unsupported FIM native decision function: python",
    });
  });

  it("throws with response body when the FIM request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      failedFimResponse(429, "rate limited"),
    );
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
});

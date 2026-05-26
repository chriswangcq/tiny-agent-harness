import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekFimAdapter } from "../src/model/adapter.js";
import { parseDsmlDecision } from "../src/model/adapter.js";
import { BASH_TOOL_DEFINITION } from "../src/tools/catalog.js";
import type { ModelStepContext } from "../src/types/model.js";

const DSML = "｜DSML｜";

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

    // Thinking pass
    expect(requestBody(fetchMock, 0)).toMatchObject({
      model: "deepseek-v4-pro",
      suffix: "</think>",
      max_tokens: 123,
    });
    expect(String(requestBody(fetchMock, 0).prompt)).toContain(
      "<｜Assistant｜><think>",
    );

    // Decision pass — V4 DSML suffix and prefix
    const decisionBody = requestBody(fetchMock, 1);
    expect(decisionBody.suffix).toBe(
      `\n</${DSML}invoke>\n</${DSML}tool_calls><｜end▁of▁sentence｜>`,
    );
    expect(decisionBody.max_tokens).toBe(45);
    const decisionPrompt = String(decisionBody.prompt);
    expect(decisionPrompt).toContain("## Tools");
    expect(decisionPrompt).toContain("Available Tool Schemas");
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

  it("rejects final decisions as unsupported", async () => {
    stubFimResponses(
      "Task is complete",
      'final<｜tool▁sep｜>{"content":"done"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Unsupported"),
    });
  });

  it("falls back to V3 format with separator", async () => {
    stubFimResponses(
      "Thinking",
      'bash<｜tool▁sep｜>{"session":"default","command":"pwd"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall.arguments).toEqual({
        session: "default",
        command: "pwd",
      });
    }
  });

  it("falls back to brace-split when native separator is missing", async () => {
    stubFimResponses(
      "Thinking",
      'bash {"session":"default","command":"pwd"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall.arguments).toEqual({
        session: "default",
        command: "pwd",
      });
    }
  });

  it("returns invalid_output when no JSON is found in decision", async () => {
    stubFimResponses("Thinking", "I should run a command");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("no DSML parameters"),
    });
  });

  it("returns invalid_output when decision JSON is invalid", async () => {
    stubFimResponses("Thinking", "bash<｜tool▁sep｜>{not json}");

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("not valid JSON"),
    });
  });

  it("returns invalid_output for unsupported decision functions", async () => {
    stubFimResponses(
      "Thinking",
      'python<｜tool▁sep｜>{"code":"print(1)"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn).toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("Unsupported"),
    });
  });

  it("strips malformed V3 boundary tokens with </ prefix", async () => {
    stubFimResponses(
      "Thinking",
      '</end▁of▁sentence｜>bash<｜tool▁sep｜>{"session":"default","command":"ls"}',
    );

    const output = await makeAdapter().generateTurn(BASE_CONTEXT, {
      bashTool: BASH_TOOL_DEFINITION,
    });

    expect(output.turn.kind).toBe("tool_call");
    if (output.turn.kind === "tool_call") {
      expect(output.turn.toolCall.arguments).toMatchObject({ command: "ls" });
    }
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

  it("handles DSML name with JSON body fallback", () => {
    const raw = 'bash">\n{"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "bash",
        arguments: { session: "default", command: "pwd" },
      },
    });
  });

  it("falls back to V3 separator format", () => {
    const raw = 'bash<｜tool▁sep｜>{"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
  });

  it("handles V3 function<sep>name format", () => {
    const raw =
      'function<｜tool▁sep｜>bash\n```json\n{"session":"default","command":"pwd"}\n```';
    const result = parseDsmlDecision(raw);
    expect(result).toEqual({
      status: "valid",
      decision: {
        name: "bash",
        arguments: { session: "default", command: "pwd" },
      },
    });
  });

  it("handles double separator: id=...<sep>bash<sep>{json}", () => {
    const raw =
      'id=fim-call-1<｜tool▁sep｜>bash<｜tool▁sep｜>{"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.decision.name).toBe("bash");
    }
  });

  it("handles trailing </tool_call> XML tag", () => {
    const raw =
      'bash<｜tool▁sep｜>{"session":"default","command":"pwd"}</tool_call>';
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
  });

  it("handles tool_call prefix format", () => {
    const raw =
      'tool_call id=fim-call-1 name=bash arguments={"session":"default","command":"pwd"}';
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.decision.arguments).toMatchObject({ command: "pwd" });
    }
  });

  it("constructs bash command from raw text after V3 separator", () => {
    const raw =
      "bash<｜tool▁sep｜>node dist/cli/main.js im send --channel default --text hello";
    const result = parseDsmlDecision(raw);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.decision.name).toBe("bash");
      expect((result.decision.arguments as Record<string, unknown>).command).toBe(
        "node dist/cli/main.js im send --channel default --text hello",
      );
    }
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

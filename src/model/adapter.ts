import type {
  ModelPrompt,
  ModelOutput,
  ModelTurn,
  ToolDefinition,
  OpenAIFunctionTool,
  OpenAIToolCall,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type AdapterConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function convertToOpenAITools(tools: ToolDefinition[]): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// OpenAICompatibleAdapter
// ---------------------------------------------------------------------------

export class OpenAICompatibleAdapter {
  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  async complete(
    prompt: ModelPrompt,
    options: { tools: ToolDefinition[] },
  ): Promise<{ output: ModelOutput; turn: ModelTurn }> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    const body = {
      model: this.config.model,
      messages: prompt.messages,
      tools: convertToOpenAITools(options.tools),
    };

    let responseData: unknown;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          output: { raw: { status: response.status, body: errorText } },
          turn: {
            kind: "invalid_output",
            message: `API request failed with status ${response.status}: ${errorText}`,
            raw: { status: response.status, body: errorText },
          },
        };
      }

      responseData = await response.json();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown fetch error";
      return {
        output: { raw: null },
        turn: {
          kind: "invalid_output",
          message: `Fetch error: ${message}`,
          raw: null,
        },
      };
    }

    return this.parseResponse(responseData);
  }

  // -------------------------------------------------------------------------
  // Response parsing
  // -------------------------------------------------------------------------

  private parseResponse(
    data: unknown,
  ): { output: ModelOutput; turn: ModelTurn } {
    const output: ModelOutput = { raw: data };

    // Validate basic response shape
    if (
      typeof data !== "object" ||
      data === null ||
      !("choices" in data) ||
      !Array.isArray((data as Record<string, unknown>).choices)
    ) {
      return {
        output,
        turn: {
          kind: "invalid_output",
          message: "Response missing choices array",
          raw: data,
        },
      };
    }

    const choices = (data as Record<string, unknown>).choices as unknown[];
    if (choices.length === 0) {
      return {
        output,
        turn: {
          kind: "invalid_output",
          message: "Response choices array is empty",
          raw: data,
        },
      };
    }

    const choice = choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;

    if (!message || typeof message !== "object") {
      return {
        output,
        turn: {
          kind: "invalid_output",
          message: "Response missing message in first choice",
          raw: data,
        },
      };
    }

    // Check for tool calls
    const toolCalls = message.tool_calls as OpenAIToolCall[] | undefined;

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const tc = toolCalls[0];

      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(tc.function.arguments);
      } catch {
        return {
          output,
          turn: {
            kind: "invalid_output",
            message: `Failed to parse tool call arguments: ${tc.function.arguments}`,
            raw: data,
          },
        };
      }

      return {
        output,
        turn: {
          kind: "tool_call",
          toolCall: {
            id: tc.id,
            name: "bash",
            arguments: parsedArguments as import("../types/index.js").BashToolInput,
          },
          raw: data,
        },
      };
    }

    // Check for final content
    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      return {
        output,
        turn: {
          kind: "final",
          content,
          raw: data,
        },
      };
    }

    return {
      output,
      turn: {
        kind: "invalid_output",
        message: "Response has neither content nor tool_calls",
        raw: data,
      },
    };
  }
}

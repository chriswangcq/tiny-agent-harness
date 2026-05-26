import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import type {
  AgentThinking,
  BashToolInput,
  FimStepOutput,
  InternalToolCall,
  ModelStepContext,
  ModelTurn,
  ToolDefinition,
  V4ChatMessage,
  V4Tool,
} from "../types/index.js";
import type { IoWaitRequest } from "../types/environment.js";

export type DeepSeekFimConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingMaxTokens: number;
  decisionMaxTokens: number;
  continuationMaxRounds?: number;
};

type FimCompletionMeta = {
  finishReasons: Array<string | null | undefined>;
  continuationRounds: number;
};

type FimCompletionResult = FimCompletionMeta & {
  text: string;
};

type FimChoice = {
  text?: string;
  finish_reason?: string | null;
  finishReason?: string | null;
};

type FimResponse = {
  choices?: FimChoice[];
  usage?: {
    completion_tokens?: number;
    completionTokens?: number;
  };
};

type Decision =
  | {
      name: "bash";
      arguments: BashToolInput;
    }
  | {
      name: "io_wait";
      arguments: {
        reason?: string;
        condition: IoWaitRequest["condition"];
      };
    };

// ---------------------------------------------------------------------------
// V4 DSML tokens
// ---------------------------------------------------------------------------

const DSML = "｜DSML｜";
const DSML_TOOL_CALLS_OPEN = `<${DSML}tool_calls>`;
const DSML_TOOL_CALLS_CLOSE = `</${DSML}tool_calls>`;
const DSML_INVOKE_OPEN_PREFIX = `<${DSML}invoke name="`;
const DSML_INVOKE_ECHO_PREFIX = `invoke name="`;
const DSML_INVOKE_CLOSE = `</${DSML}invoke>`;
const DSML_PARAM_CLOSE = `</${DSML}parameter>`;
const THINKING_STOP_SEQUENCES = [DSML_TOOL_CALLS_OPEN];

const END_OF_SENTENCE = "<｜end▁of▁sentence｜>";

// ---------------------------------------------------------------------------
// io_wait tool definition (OpenAI format for the V4 encoder)
// ---------------------------------------------------------------------------

const IO_WAIT_V4_TOOL: V4Tool = {
  type: "function",
  function: {
    name: "io_wait",
    description:
      "Pause and wait for an external event before continuing. " +
      "Use this after replying to the user or when you need to wait for user input.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you are waiting.",
        },
        condition: {
          type: "object",
          description: "The condition to wait for.",
          properties: {
            kind: {
              type: "string",
              enum: ["new_user_message", "event"],
              description: "Type of event to wait for.",
            },
            channel: {
              type: "string",
              description: "Channel to wait on (for new_user_message).",
            },
          },
          required: ["kind"],
        },
      },
      required: ["condition"],
    },
  },
};

// ---------------------------------------------------------------------------
// Python encoder path
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENCODE_SCRIPT = path.resolve(__dirname, "../../scripts/encode-prompt.py");

// ---------------------------------------------------------------------------
// DeepSeekFimAdapter
// ---------------------------------------------------------------------------

export class DeepSeekFimAdapter {
  private readonly config: DeepSeekFimConfig;

  constructor(config: DeepSeekFimConfig) {
    this.config = config;
  }

  async generateTurn(
    context: ModelStepContext,
    options: { bashTool: ToolDefinition },
  ): Promise<FimStepOutput> {
    const thinking = await this.generateThinking(context, options.bashTool);
    const decision = await this.generateDecision(
      context,
      thinking,
      options.bashTool,
    );
    const turn = this.parseDecision(context, thinking, decision.text);

    return {
      thinking,
      rawDecision: decision.text,
      turn,
      usage: {
        thinking: extractFimMeta(thinking.raw),
        decision: extractFimMeta(decision.meta),
      },
    };
  }

  private async generateThinking(
    context: ModelStepContext,
    bashTool: ToolDefinition,
  ): Promise<AgentThinking> {
    const messages = this.attachTools(context.messages, bashTool);
    const prompt = this.encodePrompt(messages);
    const completion = await this.completeFim({
      prompt,
      suffix: "</think>",
      maxTokens: this.config.thinkingMaxTokens,
      stop: THINKING_STOP_SEQUENCES,
    });

    return {
      content: completion.text,
      raw: { prompt, ...completionMeta(completion) },
    };
  }

  private async generateDecision(
    context: ModelStepContext,
    thinking: AgentThinking,
    bashTool: ToolDefinition,
  ): Promise<{ text: string; meta: FimCompletionMeta }> {
    const messages = this.attachTools(context.messages, bashTool);
    const basePrefix = this.encodePrompt(messages);
    const sanitized = sanitizeThinkingForDecisionPrompt(thinking.content);
    const prompt =
      basePrefix +
      sanitized +
      `</think>\n\n${DSML_TOOL_CALLS_OPEN}\n${DSML_INVOKE_OPEN_PREFIX}`;

    const completion = await this.completeFim({
      prompt,
      suffix: `\n${DSML_INVOKE_CLOSE}\n${DSML_TOOL_CALLS_CLOSE}${END_OF_SENTENCE}`,
      maxTokens: this.config.decisionMaxTokens,
    });

    return {
      text: completion.text,
      meta: completionMeta(completion),
    };
  }

  private attachTools(
    messages: V4ChatMessage[],
    bashTool: ToolDefinition,
  ): V4ChatMessage[] {
    const bashV4Tool: V4Tool = {
      type: "function",
      function: {
        name: bashTool.name,
        description: bashTool.description,
        parameters: bashTool.inputSchema,
      },
    };

    const result = [...messages];
    const sysIdx = result.findIndex((m) => m.role === "system");
    if (sysIdx !== -1) {
      const sys = result[sysIdx]!;
      if (sys.role === "system") {
        result[sysIdx] = { ...sys, tools: [bashV4Tool, IO_WAIT_V4_TOOL] };
      }
    }
    return result;
  }

  private encodePrompt(messages: V4ChatMessage[]): string {
    const input = JSON.stringify({ messages, thinking_mode: "thinking" });
    return execFileSync("python3", [ENCODE_SCRIPT], {
      input,
      encoding: "utf-8",
      timeout: 10_000,
    });
  }

  private async completeFim(input: {
    prompt: string;
    suffix: string;
    maxTokens: number;
    stop?: string[];
  }): Promise<FimCompletionResult> {
    const maxContinuationRounds = this.config.continuationMaxRounds ?? 4;
    const finishReasons: Array<string | null | undefined> = [];
    let text = "";
    let continuationRounds = 0;

    for (;;) {
      const chunk = await this.requestFimCompletion({
        ...input,
        prompt: input.prompt + text,
      });
      text += chunk.text;
      finishReasons.push(chunk.finishReason);

      if (
        !shouldContinueFim(chunk, input.maxTokens) ||
        continuationRounds >= maxContinuationRounds ||
        chunk.text.length === 0
      ) {
        return { text, finishReasons, continuationRounds };
      }

      continuationRounds++;
    }
  }

  private async requestFimCompletion(input: {
    prompt: string;
    suffix: string;
    maxTokens: number;
    stop?: string[];
  }): Promise<{
    text: string;
    finishReason?: string | null;
    completionTokens?: number;
  }> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      prompt: input.prompt,
      suffix: input.suffix,
      max_tokens: input.maxTokens,
    };
    if (input.stop && input.stop.length > 0) {
      body.stop = input.stop;
    }

    const response = await fetch(`${this.config.baseUrl}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `DeepSeek FIM request failed: ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as FimResponse;
    const choice = data.choices?.[0];
    const text = choice?.text;
    if (typeof text !== "string") {
      throw new Error("DeepSeek FIM response missing choices[0].text");
    }

    return {
      text,
      finishReason: choice?.finish_reason ?? choice?.finishReason,
      completionTokens:
        data.usage?.completion_tokens ?? data.usage?.completionTokens,
    };
  }

  private parseDecision(
    context: ModelStepContext,
    thinking: AgentThinking,
    rawDecision: string,
  ): ModelTurn {
    const parsed = parseDsmlDecision(rawDecision);
    if (parsed.status === "invalid") {
      return {
        kind: "invalid_output",
        message: parsed.message,
        thinking,
        rawDecision,
      };
    }

    const decision = parsed.decision;

    if (decision.name === "io_wait") {
      return {
        kind: "io_wait",
        wait: {
          reason: decision.arguments.reason,
          condition: decision.arguments.condition,
        },
        thinking,
        rawDecision,
        raw: decision,
      };
    }

    const toolCall: InternalToolCall = {
      id: `fim-call-${context.runId}-${context.stepIndex}`,
      name: "bash",
      arguments: decision.arguments,
      raw: decision,
    };

    return {
      kind: "tool_call",
      toolCall,
      thinking,
      rawDecision,
      raw: parsed,
    };
  }
}

// ---------------------------------------------------------------------------
// Thinking sanitization
// ---------------------------------------------------------------------------

function sanitizeThinkingForDecisionPrompt(content: string): string {
  const withoutThinkTags = content.replace(/<\/?think>/gi, "");
  const withoutDsmlBlocks = withoutThinkTags
    .replace(/<｜DSML｜tool_calls>[\s\S]*?(?:<\/｜DSML｜tool_calls>|$)/g, "")
    .replace(/<｜DSML｜invoke name="[^"]*">[\s\S]*?(?:<\/｜DSML｜invoke>|$)/g, "");

  const safeLines = withoutDsmlBlocks
    .split(/\r?\n/)
    .filter((line) => !line.includes("｜tool"))
    .filter((line) => !line.includes("｜DSML｜"))
    .filter((line) => !line.includes("<tool_call"))
    .filter((line) => !line.includes("</tool_call>"));

  const sanitized = safeLines.join("\n").trim();
  return sanitized || "Prior thinking contained only decision-frame markup and was omitted.";
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

export type ParseDecisionResult =
  | { status: "valid"; decision: Decision }
  | { status: "invalid"; message: string };

export function parseDsmlDecision(rawDecision: string): ParseDecisionResult {
  const text = rawDecision.trim();

  if (looksLikeDsml(text)) {
    return parseDsml(text);
  }

  return {
    status: "invalid",
    message: "Expected a V4 DSML tool call.",
  };
}

// ---------------------------------------------------------------------------
// DSML parser (V4 primary format)
// ---------------------------------------------------------------------------

function looksLikeDsml(text: string): boolean {
  return (
    text.includes(DSML) ||
    text.includes(DSML_INVOKE_OPEN_PREFIX) ||
    text.startsWith(DSML_INVOKE_ECHO_PREFIX) ||
    /^[A-Za-z_][A-Za-z0-9_]*">\s*/.test(text)
  );
}

function parseDsml(raw: string): ParseDecisionResult {
  let text = raw;

  // Strip trailing close tokens the model might echo from the suffix
  for (const token of [END_OF_SENTENCE, DSML_TOOL_CALLS_CLOSE, DSML_INVOKE_CLOSE]) {
    const idx = text.lastIndexOf(token);
    if (idx !== -1) text = text.slice(0, idx);
  }
  text = text.trim();

  if (text.startsWith(DSML_TOOL_CALLS_OPEN)) {
    text = text.slice(DSML_TOOL_CALLS_OPEN.length).trim();
  }

  // If the model repeated the invoke-open prefix, skip to the last occurrence
  const lastInvoke = text.lastIndexOf(DSML_INVOKE_OPEN_PREFIX);
  if (lastInvoke !== -1) {
    text = text.slice(lastInvoke + DSML_INVOKE_OPEN_PREFIX.length);
  } else if (text.startsWith(DSML_INVOKE_ECHO_PREFIX)) {
    text = text.slice(DSML_INVOKE_ECHO_PREFIX.length);
  }

  // Expected: functionName">\n<params>
  const quoteClose = text.indexOf('">');
  if (quoteClose === -1) {
    return {
      status: "invalid",
      message: 'Malformed DSML tool call: missing function name terminator `">`.',
    };
  }

  const name = text.slice(0, quoteClose).trim();
  if (!name || name.length > 50) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: invalid function name.",
    };
  }

  const rest = text.slice(quoteClose + 2);
  const openParameterCount = countOccurrences(
    rest,
    `<${DSML}parameter`,
  );
  const closeParameterCount = countOccurrences(rest, DSML_PARAM_CLOSE);

  if (openParameterCount > closeParameterCount) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: unclosed DSML parameter tag.",
    };
  }

  const params = parseDsmlParameters(rest);
  if (Object.keys(params).length > 0) {
    return buildDecision(name, params);
  }

  if (openParameterCount > 0) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: no complete DSML parameters found.",
    };
  }

  if (rest.includes("{")) {
    return {
      status: "invalid",
      message:
        "Malformed DSML tool call: expected DSML parameter tags, not raw JSON.",
    };
  }

  return {
    status: "invalid",
    message: "Malformed DSML tool call: expected DSML parameter tags.",
  };
}

function parseDsmlParameters(text: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const paramRegex = new RegExp(
    `<${escapeForRegex(DSML)}parameter\\s+name="([^"]*)"\\s+string="(true|false)"` +
      `>([\\s\\S]*?)</${escapeForRegex(DSML)}parameter>`,
    "g",
  );

  let match;
  while ((match = paramRegex.exec(text)) !== null) {
    const paramName = match[1]!;
    const isString = match[2] === "true";
    const value = match[3]!;

    if (isString) {
      params[paramName] = value;
    } else {
      try {
        params[paramName] = JSON.parse(value);
      } catch {
        params[paramName] = value;
      }
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildDecision(
  name: string,
  args: Record<string, unknown>,
): ParseDecisionResult {
  if (name === "bash") {
    return {
      status: "valid",
      decision: { name: "bash", arguments: args as BashToolInput },
    };
  }

  if (name === "io_wait") {
    if (!isIoWaitArguments(args)) {
      return {
        status: "invalid",
        message: "io_wait arguments did not match the expected schema.",
      };
    }
    return {
      status: "valid",
      decision: { name: "io_wait", arguments: args },
    };
  }

  return {
    status: "invalid",
    message: `Unsupported function: ${name}`,
  };
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIoWaitArguments(
  value: unknown,
): value is { reason?: string; condition: IoWaitRequest["condition"] } {
  if (!isRecord(value) || !isRecord(value.condition)) {
    return false;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return false;
  }
  return true;
}

function shouldContinueFim(
  chunk: { finishReason?: string | null; completionTokens?: number },
  maxTokens: number,
): boolean {
  const finishReason = (chunk.finishReason ?? "").toLowerCase();
  if (finishReason) {
    return (
      finishReason === "length" ||
      finishReason === "max_tokens" ||
      finishReason === "max_tokens_exceeded"
    );
  }
  return (
    typeof chunk.completionTokens === "number" &&
    chunk.completionTokens >= maxTokens
  );
}

function completionMeta(value: FimCompletionMeta): FimCompletionMeta {
  return {
    finishReasons: value.finishReasons,
    continuationRounds: value.continuationRounds,
  };
}

function extractFimMeta(value: unknown): FimCompletionMeta | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.finishReasons)) return undefined;
  const continuationRounds = value.continuationRounds;
  if (typeof continuationRounds !== "number") return undefined;
  return {
    finishReasons: value.finishReasons.map((reason) =>
      typeof reason === "string"
        ? reason
        : reason == null
          ? reason
          : String(reason),
    ),
    continuationRounds,
  };
}

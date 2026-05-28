import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import type {
  AgentThinking,
  BashToolInput,
  FimStepOutput,
  InternalToolCall,
  ModelProgressEvent,
  ModelStepContext,
  ModelTurn,
  StashFileInput,
  ToolDefinition,
  ToolName,
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
  requestRetryMaxAttempts?: number;
  requestRetryInitialDelayMs?: number;
  requestRetryMaxDelayMs?: number;
};

type FimCompletionMeta = {
  finishReasons: Array<string | null | undefined>;
  continuationRounds: number;
  usages?: FimProviderUsage[];
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
  usage?: FimProviderUsage | null;
};

type FimProviderUsage = {
  prompt_tokens?: number;
  promptTokens?: number;
  prompt_cache_hit_tokens?: number;
  promptCacheHitTokens?: number;
  prompt_cache_miss_tokens?: number;
  promptCacheMissTokens?: number;
  completion_tokens?: number;
  completionTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
};

type FimCompletionChunk = {
  text: string;
  finishReason?: string | null;
  completionTokens?: number;
  usage?: FimProviderUsage;
};

type FimCompletionRequest = {
  prompt: string;
  suffix?: string;
  maxTokens: number;
  stop?: string[];
  onChunk?: (text: string) => void | Promise<void>;
  shouldStop?: () => boolean;
};

type FimCompletionHttpInput = {
  prompt: string;
  suffix?: string;
  maxTokens: number;
  stop?: string[];
  onChunk?: (text: string) => void | Promise<void>;
};

type FimCompletionStreamResult = {
  text: string;
  finishReason?: string | null;
  completionTokens?: number;
  usage?: FimProviderUsage;
};

type FimStreamChunk = FimResponse;

type Decision =
  | {
      name: "bash";
      arguments: BashToolInput;
    }
  | {
      name: "stash_file";
      arguments: StashFileInput;
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
const END_OF_SENTENCE = "<｜end▁of▁sentence｜>";

const THINKING_STOP_SEQUENCES = [DSML_TOOL_CALLS_OPEN];
const DECISION_STOP_SEQUENCES = [DSML_INVOKE_CLOSE];
const DECISION_TRAILER = `\n${DSML_INVOKE_CLOSE}\n${DSML_TOOL_CALLS_CLOSE}${END_OF_SENTENCE}`;

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
    options: {
      tools: ToolDefinition[];
      onProgress?: (event: ModelProgressEvent) => void | Promise<void>;
    },
  ): Promise<FimStepOutput> {
    const thinking = await this.generateThinking(
      context,
      options.tools,
      options.onProgress,
    );
    const decision = await this.generateDecision(
      context,
      thinking,
      options.tools,
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
    tools: ToolDefinition[],
    onProgress?: (event: ModelProgressEvent) => void | Promise<void>,
  ): Promise<AgentThinking> {
    const messages = this.attachTools(context.messages, tools);
    const prompt = this.encodePrompt(messages);
    const progressEmitter = createThinkingProgressEmitter(onProgress);
    const completion = await this.completeFim({
      prompt,
      suffix: "</think>",
      maxTokens: this.config.thinkingMaxTokens,
      stop: THINKING_STOP_SEQUENCES,
      onChunk: progressEmitter.push,
      shouldStop: progressEmitter.isClosed,
    });
    await progressEmitter.flush();

    return {
      content: normalizeThinkingContent(completion.text),
      raw: { prompt, ...completionMeta(completion) },
    };
  }

  private async generateDecision(
    context: ModelStepContext,
    thinking: AgentThinking,
    tools: ToolDefinition[],
  ): Promise<{ text: string; meta: FimCompletionMeta }> {
    const messages = this.attachTools(context.messages, tools);
    const basePrefix = this.encodePrompt(messages);
    const sanitized = sanitizeThinkingForDecisionPrompt(thinking.content);
    const prompt =
      basePrefix +
      sanitized +
      `</think>\n\n${DSML_TOOL_CALLS_OPEN}\n${DSML_INVOKE_OPEN_PREFIX}`;

    const completion = await this.completeFim({
      prompt,
      maxTokens: this.config.decisionMaxTokens,
      stop: DECISION_STOP_SEQUENCES,
    });

    return {
      text: completion.text + DECISION_TRAILER,
      meta: completionMeta(completion),
    };
  }

  private attachTools(
    messages: V4ChatMessage[],
    tools: ToolDefinition[],
  ): V4ChatMessage[] {
    const v4Tools: V4Tool[] = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const result = [...messages];
    const sysIdx = result.findIndex((m) => m.role === "system");
    if (sysIdx !== -1) {
      const sys = result[sysIdx]!;
      if (sys.role === "system") {
        result[sysIdx] = { ...sys, tools: [...v4Tools, IO_WAIT_V4_TOOL] };
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

  private async completeFim(
    input: FimCompletionRequest,
  ): Promise<FimCompletionResult> {
    const maxContinuationRounds = this.config.continuationMaxRounds ?? 4;
    const finishReasons: Array<string | null | undefined> = [];
    const usages: FimProviderUsage[] = [];
    let text = "";
    let continuationRounds = 0;

    for (;;) {
      const chunk = await this.requestFimCompletion({
        ...input,
        prompt: input.prompt + text,
        onChunk: input.onChunk,
      });
      text += chunk.text;
      finishReasons.push(chunk.finishReason);
      if (chunk.usage) {
        usages.push(chunk.usage);
      }

      if (
        input.shouldStop?.() ||
        !shouldContinueFim(chunk, input.maxTokens) ||
        continuationRounds >= maxContinuationRounds ||
        chunk.text.length === 0
      ) {
        return {
          text,
          finishReasons,
          continuationRounds,
          ...(usages.length > 0 ? { usages } : {}),
        };
      }

      continuationRounds++;
    }
  }

  private async requestFimCompletion(
    input: FimCompletionHttpInput,
  ): Promise<FimCompletionChunk> {
    const maxAttempts = positiveIntegerOrDefault(
      this.config.requestRetryMaxAttempts,
      3,
    );
    let lastRetryableError: RetryableFimRequestError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.requestFimCompletionOnce(input);
      } catch (error) {
        if (!isRetryableFimRequestError(error)) {
          throw error;
        }

        lastRetryableError = error;
        if (attempt >= maxAttempts) break;

        await delay(this.requestRetryDelayMs(attempt));
      }
    }

    const message = lastRetryableError
      ? `${lastRetryableError.message} (after ${maxAttempts} attempts)`
      : `DeepSeek FIM request failed after ${maxAttempts} attempts`;
    throw new Error(message, { cause: lastRetryableError });
  }

  private async requestFimCompletionOnce(
    input: FimCompletionHttpInput,
  ): Promise<FimCompletionChunk> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      prompt: input.prompt,
      max_tokens: input.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (input.suffix !== undefined) {
      body.suffix = input.suffix;
    }
    if (input.stop && input.stop.length > 0) {
      body.stop = input.stop;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new RetryableFimRequestError(
        `DeepSeek FIM request failed before response: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const body = await response.text();
      const message = `DeepSeek FIM request failed: ${response.status} ${body}`;
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableFimRequestError(message, {
          status: response.status,
        });
      }
      throw new Error(message);
    }

    return this.readFimCompletionStream(response, input.onChunk);
  }

  private requestRetryDelayMs(completedAttempt: number): number {
    const initialDelay = nonNegativeNumberOrDefault(
      this.config.requestRetryInitialDelayMs,
      500,
    );
    const maxDelay = nonNegativeNumberOrDefault(
      this.config.requestRetryMaxDelayMs,
      4_000,
    );
    const exponentialDelay =
      initialDelay * 2 ** Math.max(0, completedAttempt - 1);
    return Math.min(exponentialDelay, maxDelay);
  }

  private async readFimCompletionStream(
    response: Response,
    onChunk?: (text: string) => void | Promise<void>,
  ): Promise<FimCompletionStreamResult> {
    if (!response.body) {
      throw new Error("DeepSeek FIM streaming response missing body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    let finishReason: string | null | undefined;
    let completionTokens: number | undefined;
    let providerUsage: FimProviderUsage | undefined;
    let sawChoice = false;
    let pending = "";
    let streamDone = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const extracted = extractSseEventBlocks(pending);
      pending = extracted.rest;

      for (const block of extracted.blocks) {
        const event = parseSseEventBlock(block);
        if (!event) continue;
        if (event === "[DONE]") {
          pending = "";
          streamDone = true;
          break;
        }

        const chunk = parseFimStreamChunk(event);
        if (isRecord(chunk.usage)) {
          providerUsage = { ...chunk.usage };
          const usage =
            chunk.usage.completion_tokens ?? chunk.usage.completionTokens;
          if (typeof usage === "number") {
            completionTokens = usage;
          }
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        sawChoice = true;

        if (
          choice.finish_reason !== undefined ||
          choice.finishReason !== undefined
        ) {
          finishReason = choice.finish_reason ?? choice.finishReason;
        }

        if (choice.text === undefined) {
          if (finishReason !== undefined) continue;
          throw new Error("DeepSeek FIM stream chunk missing choices[0].text");
        }

        if (choice.text.length > 0) {
          textParts.push(choice.text);
          await onChunk?.(choice.text);
        }
      }

      if (streamDone) break;
    }

    if (!streamDone) {
      const finalTail = decoder.decode();
      if (finalTail.length > 0) {
        pending += finalTail;
      }
      const extracted = extractSseEventBlocks(`${pending}\n\n`);
      for (const block of extracted.blocks) {
        const tailEvent = parseSseEventBlock(block);
        if (!tailEvent) continue;
        if (tailEvent === "[DONE]") break;
        const chunk = parseFimStreamChunk(tailEvent);
        const choice = chunk.choices?.[0];
        if (choice) {
          sawChoice = true;
          finishReason =
            choice.finish_reason ?? choice.finishReason ?? finishReason;
          if (choice.text === undefined && finishReason === undefined) {
            throw new Error("DeepSeek FIM stream chunk missing choices[0].text");
          }
          if (choice.text && choice.text.length > 0) {
            textParts.push(choice.text);
            await onChunk?.(choice.text);
          }
        }
        if (isRecord(chunk.usage)) {
          providerUsage = { ...chunk.usage };
          const usage =
            chunk.usage.completion_tokens ?? chunk.usage.completionTokens;
          if (typeof usage === "number") {
            completionTokens = usage;
          }
        }
      }
    }

    if (!sawChoice) {
      throw new Error("DeepSeek FIM stream response missing choices");
    }

    return {
      text: textParts.join(""),
      finishReason,
      completionTokens,
      ...(providerUsage ? { usage: providerUsage } : {}),
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
      name: decision.name as ToolName,
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

const THINKING_BOUNDARY_MARKERS = [
  "</think>",
  DSML_TOOL_CALLS_OPEN,
  DSML_INVOKE_OPEN_PREFIX,
  "<tool_call",
  "</tool_call>",
  "｜tool",
];

const THINKING_BOUNDARY_LOOKBEHIND =
  Math.max(...THINKING_BOUNDARY_MARKERS.map((marker) => marker.length)) - 1;

function normalizeThinkingContent(content: string): string {
  const boundary = findThinkingBoundary(content);
  const safeContent =
    boundary === undefined ? content : content.slice(0, boundary.index);
  return safeContent.replace(/<think>/gi, "").trimEnd();
}

function findThinkingBoundary(
  content: string,
): { index: number; marker: string } | undefined {
  const lowerContent = content.toLowerCase();
  let result: { index: number; marker: string } | undefined;

  for (const marker of THINKING_BOUNDARY_MARKERS) {
    const index = lowerContent.indexOf(marker.toLowerCase());
    if (index === -1) continue;
    if (result === undefined || index < result.index) {
      result = { index, marker };
    }
  }

  return result;
}

function createThinkingProgressEmitter(
  onProgress?: (event: ModelProgressEvent) => void | Promise<void>,
): {
  push(text: string): Promise<void>;
  flush(): Promise<void>;
  isClosed(): boolean;
} {
  let raw = "";
  let emittedLength = 0;
  let sequence = 0;
  let closed = false;

  async function emit(final: boolean): Promise<void> {
    const normalized = normalizeThinkingContent(raw);
    const boundary = findThinkingBoundary(raw);
    const emitUpTo =
      final || boundary
        ? normalized.length
        : Math.max(0, normalized.length - THINKING_BOUNDARY_LOOKBEHIND);
    if (emitUpTo > emittedLength) {
      const content = normalized.slice(emittedLength, emitUpTo);
      emittedLength = emitUpTo;
      if (content.length > 0) {
        await onProgress?.({
          type: "thinking_delta",
          content,
          sequence,
        });
        sequence++;
      }
    }
    if (boundary) {
      closed = true;
    }
  }

  return {
    async push(text: string): Promise<void> {
      if (closed || text.length === 0) return;
      raw += text;
      await emit(false);
    },
    async flush(): Promise<void> {
      if (closed) return;
      await emit(true);
    },
    isClosed(): boolean {
      return closed;
    },
  };
}

function sanitizeThinkingForDecisionPrompt(content: string): string {
  const withoutThinkTags = normalizeThinkingContent(content);
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
// FIM streaming response parsing
// ---------------------------------------------------------------------------

function extractSseEventBlocks(raw: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let start = 0;

  for (;;) {
    const separator = findSseEventSeparator(raw, start);
    if (!separator) break;
    blocks.push(raw.slice(start, separator.index));
    start = separator.end;
  }

  return { blocks, rest: raw.slice(start) };
}

function findSseEventSeparator(
  raw: string,
  start: number,
): { index: number; end: number } | undefined {
  const lf = raw.indexOf("\n\n", start);
  const crlf = raw.indexOf("\r\n\r\n", start);

  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, end: crlf + 4 };
  if (crlf === -1) return { index: lf, end: lf + 2 };
  return lf < crlf
    ? { index: lf, end: lf + 2 }
    : { index: crlf, end: crlf + 4 };
}

function parseSseEventBlock(block: string): string | undefined {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join("");
}

function parseFimStreamChunk(raw: string): FimStreamChunk {
  try {
    return JSON.parse(raw) as FimStreamChunk;
  } catch (error) {
    throw new Error(
      `DeepSeek FIM stream chunk was not valid JSON: ${String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

export type ParseDecisionResult =
  | { status: "valid"; decision: Decision }
  | { status: "invalid"; message: string };

export function parseDsmlDecision(rawDecision: string): ParseDecisionResult {
  const text = stripTrailingDecisionFrame(rawDecision);

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
  let text = stripTrailingDecisionFrame(raw);

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

  const paramsResult = parseDsmlParameters(rest);
  if (paramsResult.status === "invalid") {
    return paramsResult;
  }

  if (Object.keys(paramsResult.params).length === 0 && rest.includes("{")) {
    return {
      status: "invalid",
      message:
        "Malformed DSML tool call: expected DSML parameter tags, not raw JSON.",
    };
  }

  if (paramsResult.extraText !== "") {
    return {
      status: "invalid",
      message:
        "Malformed DSML tool call: unexpected text outside DSML parameter tags.",
    };
  }

  if (Object.keys(paramsResult.params).length > 0) {
    return buildDecision(name, paramsResult.params);
  }

  if (openParameterCount > 0) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: no complete DSML parameters found.",
    };
  }

  return {
    status: "invalid",
    message: "Malformed DSML tool call: expected DSML parameter tags.",
  };
}

function stripTrailingDecisionFrame(raw: string): string {
  let text = raw.trim();
  let changed = true;

  while (changed) {
    changed = false;
    for (const token of [
      END_OF_SENTENCE,
      DSML_TOOL_CALLS_CLOSE,
      DSML_INVOKE_CLOSE,
    ]) {
      if (text.endsWith(token)) {
        text = text.slice(0, -token.length).trim();
        changed = true;
      }
    }
  }

  return text;
}

function parseDsmlParameters(
  text: string,
):
  | { status: "valid"; params: Record<string, unknown>; extraText: string }
  | { status: "invalid"; message: string } {
  const params: Record<string, unknown> = {};
  let extraText = "";
  let cursor = 0;
  const paramRegex = new RegExp(
    `<${escapeForRegex(DSML)}parameter\\s+name="([^"]*)"\\s+string="(true|false)"` +
      `>([\\s\\S]*?)</${escapeForRegex(DSML)}parameter>`,
    "g",
  );

  let match;
  while ((match = paramRegex.exec(text)) !== null) {
    extraText += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const paramName = match[1]!;
    const isString = match[2] === "true";
    const value = match[3]!;

    if (isString) {
      params[paramName] = value;
    } else {
      try {
        params[paramName] = JSON.parse(value);
      } catch {
        return {
          status: "invalid",
          message: `Malformed DSML tool call: parameter "${paramName}" declared string="false" but did not contain valid JSON.`,
        };
      }
    }
  }
  extraText += text.slice(cursor);

  return { status: "valid", params, extraText: extraText.trim() };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class RetryableFimRequestError extends Error {
  readonly status?: number;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = "RetryableFimRequestError";
    this.status = options?.status;
  }
}

function isRetryableFimRequestError(
  error: unknown,
): error is RetryableFimRequestError {
  return error instanceof RetryableFimRequestError;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntegerOrDefault(value: unknown, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(1, Math.trunc(value));
}

function nonNegativeNumberOrDefault(
  value: unknown,
  defaultValue: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(0, value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

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

  if (name === "stash_file") {
    return {
      status: "valid",
      decision: {
        name: "stash_file",
        arguments: args as StashFileInput,
      },
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
    ...(value.usages && value.usages.length > 0 ? { usages: value.usages } : {}),
  };
}

function extractFimMeta(value: unknown): FimCompletionMeta | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.finishReasons)) return undefined;
  const continuationRounds = value.continuationRounds;
  if (typeof continuationRounds !== "number") return undefined;
  const meta: FimCompletionMeta = {
    finishReasons: value.finishReasons.map((reason) =>
      typeof reason === "string"
        ? reason
        : reason == null
          ? reason
          : String(reason),
    ),
    continuationRounds,
  };
  if (Array.isArray(value.usages)) {
    const usages = value.usages.filter(isRecord).map((usage) => ({
      ...usage,
    }));
    if (usages.length > 0) {
      meta.usages = usages;
    }
  }
  return meta;
}

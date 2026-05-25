import type {
  AgentThinking,
  BashToolInput,
  FimStepOutput,
  InternalToolCall,
  ModelStepContext,
  ModelTurn,
  ToolDefinition,
} from "../types/index.js";
import type { IoWaitRequest } from "../types/environment.js";

export type DeepSeekFimConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingMaxTokens: number;
  decisionMaxTokens: number;
};

type Decision =
  | {
      name: "bash";
      arguments: BashToolInput;
    }
  | {
      name: "final";
      arguments: {
        content: string;
      };
    }
  | {
      name: "io_wait";
      arguments: {
        reason?: string;
        condition: IoWaitRequest["condition"];
      };
    };

const TOOL_SEP = "<｜tool▁sep｜>";
const TOOL_CALL_BEGIN = "<｜tool▁call▁begin｜>";
const TOOL_CALL_END = "<｜tool▁call▁end｜>";
const TOOL_CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
const TOOL_CALLS_END = "<｜tool▁calls▁end｜>";
const END_OF_SENTENCE = "<｜end▁of▁sentence｜>";

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
    const rawDecision = await this.generateDecision(
      context,
      thinking,
      options.bashTool,
    );
    const turn = this.parseDecision(context, thinking, rawDecision);

    return { thinking, rawDecision, turn };
  }

  private async generateThinking(
    context: ModelStepContext,
    bashTool: ToolDefinition,
  ): Promise<AgentThinking> {
    const prompt = this.renderThinkingPrompt(context, bashTool);
    const content = await this.completeFim({
      prompt,
      suffix: "</think>",
      maxTokens: this.config.thinkingMaxTokens,
    });

    return { content, raw: { prompt } };
  }

  private async generateDecision(
    context: ModelStepContext,
    thinking: AgentThinking,
    bashTool: ToolDefinition,
  ): Promise<string> {
    return this.completeFim({
      prompt: this.renderDecisionPrompt(context, thinking, bashTool),
      suffix: `${TOOL_CALL_END}${TOOL_CALLS_END}${END_OF_SENTENCE}`,
      maxTokens: this.config.decisionMaxTokens,
    });
  }

  private async completeFim(input: {
    prompt: string;
    suffix: string;
    maxTokens: number;
  }): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        prompt: input.prompt,
        suffix: input.suffix,
        max_tokens: input.maxTokens,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek FIM request failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ text?: string }>;
    };
    const text = data.choices?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("DeepSeek FIM response missing choices[0].text");
    }

    return text;
  }

  private parseDecision(
    context: ModelStepContext,
    thinking: AgentThinking,
    rawDecision: string,
  ): ModelTurn {
    const parsed = parseNativeToolDecision(rawDecision);
    if (parsed.status === "invalid") {
      return {
        kind: "invalid_output",
        message: parsed.message,
        thinking,
        rawDecision,
      };
    }

    const decision = parsed.decision;

    if (decision.name === "final") {
      return {
        kind: "final",
        content: decision.arguments.content,
        thinking,
        rawDecision,
        raw: decision,
      };
    }

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

  private renderThinkingPrompt(
    context: ModelStepContext,
    bashTool: ToolDefinition,
  ): string {
    return [
      this.renderDeepSeekChatContext(context, bashTool),
      "",
      "<｜Assistant｜><think>",
    ].join("\n");
  }

  private renderDecisionPrompt(
    context: ModelStepContext,
    thinking: AgentThinking,
    bashTool: ToolDefinition,
  ): string {
    return [
      this.renderDeepSeekChatContext(context, bashTool),
      "",
      "<｜Assistant｜><think>",
      thinking.content,
      `</think>\n${TOOL_CALLS_BEGIN}\n${TOOL_CALL_BEGIN}`,
    ].join("\n");
  }

  private renderDeepSeekChatContext(
    context: ModelStepContext,
    bashTool: ToolDefinition,
  ): string {
    const systemMessages = context.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    const nonSystemMessages = context.messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        return `[${message.role}]\n${message.content}`;
      });

    const systemPrompt = systemMessages.join("\n\n");

    return [
      `<｜begin▁of▁sentence｜>${systemPrompt}`,
      "",
      "<｜User｜>",
      `Run: ${context.runId}`,
      `Step: ${context.stepIndex}`,
      ...nonSystemMessages,
      "",
      `Decision output format: function_name${TOOL_SEP}{json_arguments}`,
      "",
      "Decision functions:",
      `- bash${TOOL_SEP}{"session":"default","command":"..."}`,
      `- io_wait${TOOL_SEP}{"reason":"...","condition":{"kind":"new_user_message","channel":"default"}}`,
      `- final${TOOL_SEP}{"content":"your final answer here"}`,
      "",
      `Bash tool schema: ${bashTool.name}`,
      bashTool.description,
      JSON.stringify(bashTool.inputSchema),
    ].join("\n");
  }
}

type ParseDecisionResult =
  | {
      status: "valid";
      decision: Decision;
    }
  | {
      status: "invalid";
      message: string;
    };

function parseNativeToolDecision(rawDecision: string): ParseDecisionResult {
  const normalized = stripNativeToolBoundaries(rawDecision.trim());
  let separatorIndex = normalized.indexOf(TOOL_SEP);

  let name: string;
  let rawArguments: string;

  if (separatorIndex !== -1) {
    name = normalized.slice(0, separatorIndex).trim();
    rawArguments = normalized.slice(separatorIndex + TOOL_SEP.length).trim();
  } else {
    // Fallback: split on the first '{' to separate function name from JSON
    const braceIndex = normalized.indexOf("{");
    if (braceIndex === -1) {
      return {
        status: "invalid",
        message: "FIM decision did not contain DeepSeek native tool separator.",
      };
    }
    name = normalized.slice(0, braceIndex).trim();
    rawArguments = normalized.slice(braceIndex).trim();
  }

  // Filter out literal placeholder names from format instructions
  if (name === "function_name" || name === "") {
    return {
      status: "invalid",
      message: "FIM decision did not contain a valid function name.",
    };
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments);
  } catch {
    return {
      status: "invalid",
      message: "FIM native tool decision arguments were not valid JSON.",
    };
  }

  if (name === "bash") {
    if (!isRecord(parsedArguments)) {
      return {
        status: "invalid",
        message: "FIM native bash decision arguments must be an object.",
      };
    }
    return {
      status: "valid",
      decision: {
        name,
        arguments: parsedArguments as BashToolInput,
      },
    };
  }

  if (name === "io_wait") {
    if (!isIoWaitArguments(parsedArguments)) {
      return {
        status: "invalid",
        message: "FIM native io_wait decision arguments did not match the schema.",
      };
    }
    return {
      status: "valid",
      decision: {
        name,
        arguments: parsedArguments,
      },
    };
  }

  if (name === "final") {
    if (!isFinalArguments(parsedArguments)) {
      return {
        status: "invalid",
        message: "FIM native final decision arguments did not match the schema.",
      };
    }
    return {
      status: "valid",
      decision: {
        name,
        arguments: parsedArguments,
      },
    };
  }

  return {
    status: "invalid",
    message: `Unsupported FIM native decision function: ${name}`,
  };
}

function stripNativeToolBoundaries(text: string): string {
  let value = text.trim();

  // Strip known boundary tokens and their malformed variants (</...｜> instead of <｜...｜>)
  const boundaryPrefixes = [
    TOOL_CALLS_BEGIN, TOOL_CALL_BEGIN,
    "</tool▁calls▁begin｜>", "</tool▁call▁begin｜>",
    "</end▁of▁sentence｜>",
  ];
  for (const prefix of boundaryPrefixes) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
    }
  }

  const endTokens = [
    TOOL_CALL_END, TOOL_CALLS_END, END_OF_SENTENCE,
    "</tool▁call▁end｜>", "</tool▁calls▁end｜>", "</end▁of▁sentence｜>",
  ];
  const endIndexes = endTokens
    .map((token) => value.indexOf(token))
    .filter((index) => index >= 0);

  if (endIndexes.length > 0) {
    value = value.slice(0, Math.min(...endIndexes)).trim();
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return !Array.isArray(value);
}

function isFinalArguments(value: unknown): value is { content: string } {
  return isRecord(value) && typeof value.content === "string";
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

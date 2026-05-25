import type {
  AgentThinking,
  BashToolInput,
  FimStepOutput,
  InternalToolCall,
  ModelStepContext,
  ModelTurn,
  ToolDefinition,
} from "../types/index.js";

export type DeepSeekFimConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingMaxTokens: number;
  decisionMaxTokens: number;
};

type Decision =
  | {
      type: "tool_call";
      name: "bash";
      arguments: BashToolInput;
    }
  | {
      type: "final";
      content: string;
    };

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
      suffix: "</agent_thinking>",
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
      suffix: "</next_decision>",
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
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawDecision);
    } catch {
      return {
        kind: "invalid_output",
        message: "FIM decision was not valid JSON.",
        thinking,
        rawDecision,
      };
    }

    if (!isDecision(parsed)) {
      return {
        kind: "invalid_output",
        message: "FIM decision did not match the decision grammar.",
        thinking,
        rawDecision,
        raw: parsed,
      };
    }

    if (parsed.type === "final") {
      return {
        kind: "final",
        content: parsed.content,
        thinking,
        rawDecision,
        raw: parsed,
      };
    }

    const toolCall: InternalToolCall = {
      id: `fim-call-${context.runId}-${context.stepIndex}`,
      name: "bash",
      arguments: parsed.arguments,
      raw: parsed,
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
      "<tah_context>",
      `Run: ${context.runId}`,
      `Step: ${context.stepIndex}`,
      ...context.messages.map((message) => {
        return `${message.role.toUpperCase()}: ${message.content}`;
      }),
      `Tool: ${bashTool.name}`,
      bashTool.description,
      "</tah_context>",
      "",
      "<agent_thinking>",
    ].join("\n");
  }

  private renderDecisionPrompt(
    context: ModelStepContext,
    thinking: AgentThinking,
    bashTool: ToolDefinition,
  ): string {
    return [
      "<tah_context>",
      `Run: ${context.runId}`,
      `Step: ${context.stepIndex}`,
      ...context.messages.map((message) => {
        return `${message.role.toUpperCase()}: ${message.content}`;
      }),
      `Tool: ${bashTool.name}`,
      bashTool.description,
      JSON.stringify(bashTool.inputSchema),
      "</tah_context>",
      "",
      "<agent_thinking>",
      thinking.content,
      "</agent_thinking>",
      "",
      "<next_decision>",
    ].join("\n");
  }
}

function isDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "final") {
    return typeof record.content === "string";
  }

  if (record.type === "tool_call") {
    return record.name === "bash" && typeof record.arguments === "object";
  }

  return false;
}

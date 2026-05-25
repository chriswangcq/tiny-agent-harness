import type { BashToolInput } from "./bash.js";

// ---------------------------------------------------------------------------
// Internal Tool Call (normalized from FIM decision)
// ---------------------------------------------------------------------------

export type InternalToolCall = {
  id: string;
  name: "bash";
  arguments: BashToolInput;
  raw?: unknown;
};

// ---------------------------------------------------------------------------
// Model Turn (output of model adapter)
// ---------------------------------------------------------------------------

export type AgentThinking = {
  content: string;
  raw?: unknown;
};

export type ModelTurn =
  | {
      kind: "final";
      content: string;
      thinking?: AgentThinking;
      rawDecision?: string;
      raw?: unknown;
    }
  | {
      kind: "tool_call";
      toolCall: InternalToolCall;
      thinking?: AgentThinking;
      rawDecision?: string;
      raw?: unknown;
    }
  | {
      kind: "invalid_output";
      message: string;
      thinking?: AgentThinking;
      rawDecision?: string;
      raw?: unknown;
    };

// ---------------------------------------------------------------------------
// Model Prompt
// ---------------------------------------------------------------------------

export type ModelPromptMessage = ChatMessage;

export type ModelPrompt = {
  messages: ModelPromptMessage[];
};

// ---------------------------------------------------------------------------
// FIM Step Output
// ---------------------------------------------------------------------------

export type FimStepOutput = {
  thinking: AgentThinking;
  rawDecision: string;
  turn: ModelTurn;
  usage?: unknown;
};

// ---------------------------------------------------------------------------
// Model Output (raw response wrapper)
// ---------------------------------------------------------------------------

export type ModelOutput = unknown;

// ---------------------------------------------------------------------------
// OpenAI-compatible API types (for request/response serialization)
// ---------------------------------------------------------------------------

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

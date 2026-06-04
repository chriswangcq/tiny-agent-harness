// ─── Model Types ────────────────────────────────────────────────────
//
// FIM decision grammar is the harness's own protocol, not provider-native
// tool calling. The model adapter normalizes FIM decisions into ModelTurn.

import type { IoWaitRequest } from "./environment.js";
import type { TerminalToolInput, ToolName } from "./tools.js";
import type { ModelProtocolDiagnostic } from "../model/dsml-decision-parser.js";
import type { NormalizedFimUsage } from "../model/token-usage-normalizer.js";

/**
 * Raw model output placeholder. Will be refined as the FIM adapter
 * implementation solidifies.
 */
export type ModelOutput = unknown;

/**
 * Agent reasoning content produced by the FIM thinking pass.
 */
export type AgentThinking = {
  content: string;
  raw?: unknown;
};

/**
 * Harness-generated tool call. FIM does not provide a provider-generated
 * tool call id, so the harness generates `id` (e.g. `fim-call-{runId}-{stepIndex}`).
 */
export type InternalToolCall = {
  id: string;
  name: ToolName;
  arguments: TerminalToolInput;
  raw?: unknown;
};

/**
 * The normalized result of a single FIM decision pass.
 *
 * - `tool_call`: the agent wants to execute a terminal/session tool.
 * - `io_wait`: the agent is waiting for external input.
 * - `invalid_output`: the FIM output could not be parsed.
 *
 * `thinking` and `rawDecision` are required on `tool_call` and `io_wait`
 * (they always come from a completed FIM two-pass) but optional on
 * `invalid_output` (the thinking pass may have succeeded even when the
 * decision is unparseable).
 */
export type ModelTurn =
  | {
      kind: "tool_call";
      toolCall: InternalToolCall;
      thinking: AgentThinking;
      rawDecision: string;
      raw?: unknown;
    }
  | {
      kind: "io_wait";
      wait: IoWaitRequest;
      thinking: AgentThinking;
      rawDecision: string;
      raw?: unknown;
    }
  | {
      kind: "invalid_output";
      message: string;
      diagnostic?: ModelProtocolDiagnostic;
      thinking?: AgentThinking;
      rawDecision?: string;
      raw?: unknown;
    };

/**
 * Full output of one FIM step (thinking + decision + parsed turn).
 */
export type FimStepOutput = {
  thinking: AgentThinking;
  rawDecision: string;
  turn: ModelTurn;
  usage?: NormalizedFimUsage;
};

/**
 * Incremental progress emitted while the model is still producing a step.
 *
 * These events are observability-only: the orchestrator may collect them into
 * debug trace artifacts without changing the final ModelTurn contract.
 */
export type ModelProgressEvent = {
  type: "thinking_delta";
  content: string;
  sequence: number;
};

/**
 * A single message in the model prompt.
 */
export type ModelPromptMessage = {
  role: "system" | "user" | "assistant" | "observation";
  content: string;
};

// ---------------------------------------------------------------------------
// V4 chat message types (OpenAI-compatible, for Python encoder)
// ---------------------------------------------------------------------------

export type V4ChatMessage =
  | V4SystemMessage
  | V4UserMessage
  | V4AssistantMessage
  | V4ToolMessage
  | V4LatestReminderMessage;

export type V4SystemMessage = {
  role: "system";
  content: string;
  tools?: V4Tool[];
};

export type V4UserMessage = {
  role: "user";
  content: string;
};

export type V4AssistantMessage = {
  role: "assistant";
  content: string;
  reasoning?: string;
  tool_calls?: V4ToolCall[];
};

export type V4ToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type V4LatestReminderMessage = {
  role: "latest_reminder";
  content: string;
};

export type V4Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

export type V4ToolCall = {
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * Context passed to the FIM adapter for a single model step.
 */
export type ModelStepContext = {
  runId: string;
  stepIndex: number;
  messages: V4ChatMessage[];
};

/**
 * The full prompt structure sent to the model.
 */
export type ModelPrompt = {
  messages: ModelPromptMessage[];
};

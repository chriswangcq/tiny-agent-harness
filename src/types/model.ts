// ─── Model Types ────────────────────────────────────────────────────
//
// FIM decision grammar is the harness's own protocol, not provider-native
// tool calling. The model adapter normalizes FIM decisions into ModelTurn.

import type { BashToolInput } from "./bash.js";
import type { IoWaitRequest } from "./environment.js";

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
  name: "bash";
  arguments: BashToolInput;
  raw?: unknown;
};

/**
 * The normalized result of a single FIM decision pass.
 *
 * - `tool_call`: the agent wants to execute a bash command or control.
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
  usage?: unknown;
};

/**
 * A single message in the model prompt.
 */
export type ModelPromptMessage = {
  role: "system" | "user" | "assistant" | "observation";
  content: string;
};

/**
 * Context passed to the FIM adapter for a single model step.
 */
export type ModelStepContext = {
  runId: string;
  stepIndex: number;
  messages: ModelPromptMessage[];
};

/**
 * The full prompt structure sent to the model.
 */
export type ModelPrompt = {
  messages: ModelPromptMessage[];
};

// ─── Tool Types ─────────────────────────────────────────────────────
//
// Static tool catalog, tool request/review/result, and validation types.

import type { EnvironmentEvent } from "./environment.js";
import type {
  SessionFocusRequest,
  SessionInterruptRequest,
  SessionListObservation,
  SessionObserveRequest,
  SessionRestartRequest,
  SessionTerminateRequest,
  TerminalKeyRequest,
  TerminalObservation,
  TerminalToolRequest,
  TerminalWriteRequest,
} from "../terminal/types.js";

// ─── Tool Catalog ───────────────────────────────────────────────────

export const MODEL_VISIBLE_TOOL_NAMES = [
  "terminal_write",
  "terminal_key",
  "session_observe",
  "session_list",
  "session_focus",
  "session_interrupt",
  "session_restart",
  "session_terminate",
] as const;

export type ToolName = (typeof MODEL_VISIBLE_TOOL_NAMES)[number];

/** A JSON Schema value (opaque to the harness). */
export type JsonSchema = Record<string, unknown>;

/** Common tool definition shape handed to the FIM adapter. */
export type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
};

// ─── Tool Request (validated, ready for review) ─────────────────────

export type TerminalWriteToolInput = Omit<TerminalWriteRequest, "kind">;
export type TerminalKeyToolInput = Omit<TerminalKeyRequest, "kind">;
export type SessionObserveToolInput = Omit<SessionObserveRequest, "kind">;
export type SessionListToolInput = Record<string, never>;
export type SessionFocusToolInput = Omit<SessionFocusRequest, "kind">;
export type SessionInterruptToolInput = Omit<SessionInterruptRequest, "kind">;
export type SessionRestartToolInput = Omit<SessionRestartRequest, "kind">;
export type SessionTerminateToolInput = Omit<SessionTerminateRequest, "kind">;

export type ToolInputByName = {
  terminal_write: TerminalWriteToolInput;
  terminal_key: TerminalKeyToolInput;
  session_observe: SessionObserveToolInput;
  session_list: SessionListToolInput;
  session_focus: SessionFocusToolInput;
  session_interrupt: SessionInterruptToolInput;
  session_restart: SessionRestartToolInput;
  session_terminate: SessionTerminateToolInput;
};

export type TerminalToolInput = ToolInputByName[ToolName];

export type ToolRequest = {
  kind: "terminal_tool";
  toolName: ToolName;
  toolCallId: string;
  request: TerminalToolRequest;
};

// ─── Tool Review ────────────────────────────────────────────────────

export type ToolReviewDecision = {
  status: "approved" | "rejected";
  reason: string;
  reviewer: string;
  warnings?: string[];
  /** Risk findings from policy evaluation (present when reviewer is "tool-policy"). */
  findings?: {
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }[];
  /** Structured risk reasons derived from findings for audit correlation. */
  riskReasons?: {
    code: string;
    severity: "info" | "warning" | "error";
    description: string;
  }[];
};

// ─── Tool Result ────────────────────────────────────────────────────

export type ToolResult = {
  toolCallId: string;
  toolName: ToolName;
  observation: ToolObservation;
};

export type ToolObservation =
  | TerminalObservation
  | SessionListObservation
  | AgentObservation;

// ─── Tool Call Validation ───────────────────────────────────────────

export type ToolCallValidation =
  | { status: "valid"; request: ToolRequest }
  | { status: "invalid"; observation: AgentObservation };

// ─── Agent Observation ──────────────────────────────────────────────
//
// Synthetic observations fed back to the model for recoverable failures
// (invalid output, validation errors, review rejections).

export type AgentObservation =
  {
    kind: "model_output" | "tool_validation" | "tool_review" | "io_wait";
    message: string;
    recoverable: boolean;
    decision?: {
      status: "approved" | "rejected";
      reason: string;
    };
    event?: EnvironmentEvent;
  };

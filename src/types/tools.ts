// ─── Tool Types ─────────────────────────────────────────────────────
//
// Static tool catalog, tool request/review/result, and validation types.
// The first version has exactly one tool: bash.

import type { BashObservation } from "./bash.js";

// ─── Tool Catalog ───────────────────────────────────────────────────

/** The only tool name supported in v1. */
export type ToolName = "bash";

/** A JSON Schema value (opaque to the harness). */
export type JsonSchema = Record<string, unknown>;

/** Common tool definition shape handed to the FIM adapter. */
export type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
};

// ─── Tool Request (validated, ready for review) ─────────────────────

export type ToolRequest =
  | {
      kind: "command";
      toolName: "bash";
      toolCallId: string;
      session: string;
      command: string;
      timeoutMs: number;
    }
  | {
      kind: "control";
      toolName: "bash";
      toolCallId: string;
      session?: string;
      control:
        | "list"
        | "create"
        | "status"
        | "poll"
        | "sendInput"
        | "interrupt"
        | "terminate"
        | "restart";
      input?: string;
      createOptions?: {
        cwd?: string;
        shell?: string;
        env?: Record<string, string>;
        defaultTimeoutMs?: number;
        maxObservationBytes?: number;
      };
    };

// ─── Tool Review ────────────────────────────────────────────────────

export type ToolReviewDecision = {
  status: "approved" | "rejected";
  reason: string;
  reviewer: string;
  warnings?: string[];
};

// ─── Tool Result ────────────────────────────────────────────────────

export type ToolResult = {
  toolCallId: string;
  toolName: "bash";
  observation: BashObservation | AgentObservation;
};

// ─── Tool Call Validation ───────────────────────────────────────────

export type ToolCallValidation =
  | { status: "valid"; request: ToolRequest }
  | { status: "invalid"; observation: AgentObservation };

// ─── Agent Observation ──────────────────────────────────────────────
//
// Synthetic observations fed back to the model for recoverable failures
// (invalid output, validation errors, review rejections).

export type AgentObservation = {
  kind: "model_output" | "tool_validation" | "tool_review";
  message: string;
  recoverable: boolean;
  decision?: {
    status: "approved" | "rejected";
    reason: string;
  };
};

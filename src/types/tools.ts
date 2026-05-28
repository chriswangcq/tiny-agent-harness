// ─── Tool Types ─────────────────────────────────────────────────────
//
// Static tool catalog, tool request/review/result, and validation types.

import type { EnvironmentEvent } from "./environment.js";
import type { PtyAction, PtyObservation } from "../terminal/types.js";

// ─── Tool Catalog ───────────────────────────────────────────────────

export type ToolName = "bash" | "stash_file";

/** A JSON Schema value (opaque to the harness). */
export type JsonSchema = Record<string, unknown>;

/** Common tool definition shape handed to the FIM adapter. */
export type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
};

// ─── Tool Request (validated, ready for review) ─────────────────────

export type BashToolRequest = {
  kind: "pty_action";
  toolName: "bash";
  toolCallId: string;
  action: PtyAction;
};

export type StashFileInput = {
  name?: string;
  content: string;
  encoding?: "utf8" | "base64";
  description?: string;
};

export type StashFileToolRequest = {
  kind: "stash_file";
  toolName: "stash_file";
  toolCallId: string;
  name?: string;
  content: string;
  encoding: "utf8" | "base64";
  description?: string;
};

export type ToolRequest = BashToolRequest | StashFileToolRequest;

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
  toolName: ToolName;
  observation: PtyObservation | AgentObservation;
};

// ─── Tool Call Validation ───────────────────────────────────────────

export type ToolCallValidation =
  | { status: "valid"; request: ToolRequest }
  | { status: "invalid"; observation: AgentObservation };

// ─── Agent Observation ──────────────────────────────────────────────
//
// Synthetic observations fed back to the model for recoverable failures
// (invalid output, validation errors, review rejections).

export type AgentObservation =
  | {
      kind: "model_output" | "tool_validation" | "tool_review" | "io_wait";
      message: string;
      recoverable: boolean;
      decision?: {
        status: "approved" | "rejected";
        reason: string;
      };
      event?: EnvironmentEvent;
    }
  | {
      kind: "stash_file";
      message: string;
      recoverable: false;
      stashId: string;
      name: string;
      bytes: number;
      materializeCommand: string;
    };

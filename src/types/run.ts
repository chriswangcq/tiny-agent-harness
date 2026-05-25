// ─── Run Orchestrator Types ─────────────────────────────────────────
//
// Agent run state machine, effects, events, and errors.

import type {
  ModelTurn,
  FimStepOutput,
  InternalToolCall,
  ModelStepContext,
} from "./model.js";
import type {
  ToolRequest,
  ToolReviewDecision,
  ToolCallValidation,
  AgentObservation,
} from "./tools.js";
import type { BashObservation } from "./bash.js";

// ─── Agent Run Status ───────────────────────────────────────────────

export type AgentRunStatus =
  | "created"
  | "running"
  | "waiting_for_model"
  | "waiting_for_review"
  | "waiting_for_tool"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Agent Run State Data ───────────────────────────────────────────

export interface AgentRunStateData {
  runId: string;
  status: AgentRunStatus;

  task: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;

  stepIndex: number;
  maxSteps: number;

  transcriptPath: string;
  lastEventId?: string;

  pendingModelOutput?: FimStepOutput;
  pendingModelTurn?: ModelTurn;
  pendingToolCall?: InternalToolCall;
  pendingToolRequest?: ToolRequest;
  pendingReview?: ToolReviewDecision;

  final?: string;
  error?: RunError;
}

// ─── Next Effect ────────────────────────────────────────────────────
//
// `nextEffect(state)` is the only instruction outlet from AgentRunState
// to the orchestrator.

export type NextEffect =
  | {
      type: "call_model";
      context: ModelStepContext;
    }
  | {
      type: "validate_tool_call";
      toolCall: InternalToolCall;
    }
  | {
      type: "review_tool";
      request: ToolRequest;
    }
  | {
      type: "execute_tool";
      request: ToolRequest;
      review: ToolReviewDecision;
    }
  | {
      type: "append_observation";
      observation: AgentObservation;
    }
  | {
      type: "stop";
      reason: "final" | "max_steps" | "failed" | "cancelled";
    };

// ─── IM transport message types ─────────────────────────────────────

export type UserMessage = {
  content: string;
  timestamp: string;
};

export type AgentMessage = {
  content: string;
  timestamp: string;
};

// ─── Run Events ─────────────────────────────────────────────────────
//
// State changes are driven by events. Events are also appended to
// the transcript JSONL for audit.

export type RunEvent =
  | {
      type: "run_started";
      runId: string;
      task: string;
      cwd: string;
      maxSteps: number;
      timestamp: string;
    }
  | {
      type: "model_requested";
      stepIndex: number;
      timestamp: string;
    }
  | {
      type: "model_output_received";
      stepIndex: number;
      output: FimStepOutput;
      turn: ModelTurn;
      timestamp: string;
    }
  | {
      type: "user_message_received";
      runId: string;
      message: UserMessage;
      timestamp: string;
    }
  | {
      type: "agent_message_sent";
      runId: string;
      message: AgentMessage;
      timestamp: string;
    }
  | {
      type: "tool_call_validated";
      stepIndex: number;
      toolCall: InternalToolCall;
      result: ToolCallValidation;
      timestamp: string;
    }
  | {
      type: "tool_review_requested";
      stepIndex: number;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_reviewed";
      stepIndex: number;
      request: ToolRequest;
      decision: ToolReviewDecision;
      timestamp: string;
    }
  | {
      type: "tool_execution_started";
      stepIndex: number;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_execution_finished";
      stepIndex: number;
      request: ToolRequest;
      observation: BashObservation;
      timestamp: string;
    }
  | {
      type: "observation_appended";
      stepIndex: number;
      observation: AgentObservation;
      timestamp: string;
    }
  | {
      type: "run_finished";
      status: "completed" | "failed" | "cancelled";
      final?: string;
      error?: RunError;
      timestamp: string;
    };

// ─── Run Error ──────────────────────────────────────────────────────

export type RunError = {
  message: string;
  code?: string;
  details?: unknown;
};

// ─── Model Prompt (re-export convenience) ───────────────────────────
// ModelPrompt is defined in model.ts; re-exported here for discoverability
// by consumers that only import from run.ts.

export type { ModelStepContext } from "./model.js";

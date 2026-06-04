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
  ToolObservation,
} from "./tools.js";
import type {
  EnvironmentEvent,
  IoWaitRequest,
  UserMessage,
  AgentMessage,
} from "./environment.js";
import type { ActiveSkillRunSummary } from "./skill.js";
import type { ModelContextCompactionResult } from "../model/context-window.js";

// ─── Agent Run Status ───────────────────────────────────────────────

export type AgentRunStatus =
  | "created"
  | "running"
  | "waiting_for_model"
  | "waiting_for_review"
  | "waiting_for_tool"
  | "waiting_for_io"
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

  transcriptPath: string;
  lastEventId?: string;

  pendingModelOutput?: FimStepOutput;
  pendingModelTurn?: ModelTurn;
  pendingToolCall?: InternalToolCall;
  pendingToolRequest?: ToolRequest;
  pendingReview?: ToolReviewDecision;
  pendingIoWait?: IoWaitRequest;

  
  pendingObservation?: AgentObservation;

  
  runtimeProgress?: RuntimeProgressState;

  activeSkillRuns?: ActiveSkillRunSummary[];

  error?: RunError;
}

// ─── Runtime Progress / Stuck Detection ───────────────────────────────

export type RuntimeStuckSeverity = "warn" | "blocked";

export type RuntimeNoProgressPattern =
  | "repeated_model_output"
  | "repeated_tool_validation"
  | "repeated_tool_review"
  | "repeated_io_wait"
  | "repeated_tool_error";

export type RuntimeNoProgressSignal =
  | {
      kind: "model_output" | "tool_validation" | "tool_review" | "io_wait";
      message: string;
    }
  | {
      kind: "tool_error";
      toolName: string;
      request: string;
      result: string;
      errorCode?: string;
      message?: string;
    };

export type RuntimeNoProgressState = {
  signature: string;
  pattern: RuntimeNoProgressPattern;
  signal: RuntimeNoProgressSignal;
  consecutiveCount: number;
  sinceStepIndex: number;
  lastStepIndex: number;
  lastReportedSeverity?: RuntimeStuckSeverity;
};

export type RuntimeStuckReason = {
  code: "repeated_no_progress";
  severity: RuntimeStuckSeverity;
  pattern: RuntimeNoProgressPattern;
  message: string;
  signal: RuntimeNoProgressSignal;
  signature: string;
  consecutiveCount: number;
  threshold: number;
  warnThreshold: number;
  blockThreshold: number;
  sinceStepIndex: number;
  lastStepIndex: number;
};

export type RuntimeProgressState = {
  noProgress?: RuntimeNoProgressState;
  stuckReason?: RuntimeStuckReason;
};

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
      type: "wait_io";
      wait: IoWaitRequest;
    }
  | {
      type: "stop";
      reason: "failed" | "cancelled";
    };

// ─── Model Decision Trace ────────────────────────────────────────────

export type RunArtifactRef = {
  path: string;
  relativePath: string;
  bytes: number;
  sha256: string;
};

export type ModelDecisionTrace = {
  schemaVersion: 1;
  decisionId: string;
  stepIndex: number;
  kind: ModelTurn["kind"];
  thinking: {
    contentChars: number;
    contentBytes: number;
    promptRef?: RunArtifactRef;
    traceRef?: RunArtifactRef;
  };
  rawDecision?: {
    bytes: number;
    sha256: string;
    preview: string;
  };
  toolCall?: {
    id: InternalToolCall["id"];
    name: InternalToolCall["name"];
    arguments: InternalToolCall["arguments"];
  };
  ioWait?: IoWaitRequest;
  invalidOutput?: {
    message: string;
    diagnostic?: Extract<ModelTurn, { kind: "invalid_output" }>["diagnostic"];
  };
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
      timestamp: string;
    }
  | {
      type: "run_resumed";
      runId: string;
      previousStatus: AgentRunStatus;
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
      type: "model_decision_recorded";
      stepIndex: number;
      decision: ModelDecisionTrace;
      timestamp: string;
    }
  | {
      type: "model_thinking_delta";
      stepIndex: number;
      delta: string;
      sequence: number;
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
      type: "io_wait_started";
      stepIndex: number;
      decisionId?: string;
      wait: IoWaitRequest;
      timestamp: string;
    }
  | {
      type: "io_wait_satisfied";
      stepIndex: number;
      decisionId?: string;
      wait: IoWaitRequest;
      event: EnvironmentEvent;
      timestamp: string;
    }
  | {
      type: "environment_event_recorded";
      event: EnvironmentEvent;
      timestamp: string;
    }
  | {
      type: "environment_events_consumed";
      runId: string;
      eventIds: string[];
      timestamp: string;
    }
  | {
      type: "history_compacted";
      stepIndex: number;
      compaction: Omit<ModelContextCompactionResult, "items">;
      timestamp: string;
    }
  | {
      type: "runtime_stuck_detected";
      stepIndex: number;
      severity: RuntimeStuckSeverity;
      reason: RuntimeStuckReason;
      timestamp: string;
    }
  | {
      type: "tool_call_validated";
      stepIndex: number;
      decisionId?: string;
      toolCall: InternalToolCall;
      result: ToolCallValidation;
      timestamp: string;
    }
  | {
      type: "tool_review_requested";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_reviewed";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      decision: ToolReviewDecision;
      timestamp: string;
    }
  | {
      type: "tool_execution_started";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_execution_finished";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      observation: ToolObservation;
      timestamp: string;
    }
  | {
      type: "observation_appended";
      stepIndex: number;
      decisionId?: string;
      observation: AgentObservation;
      timestamp: string;
    }
  | {
      type: "run_finished";
      status: "failed" | "cancelled";
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

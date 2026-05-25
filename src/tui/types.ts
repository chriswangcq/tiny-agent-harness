// ─── TUI View-Model & Renderer Types ────────────────────────────────
//
// Pure type definitions for the terminal user interface layer.
// No runtime code except the DEFAULT_TUI_LIMITS constant.

import type { AgentRunStatus } from "../types/run.js";

// ─── Top-level View Model ──────────────────────────────────────────

export type TuiViewModel = {
  run: RunHeaderView;
  conversation: ConversationItem[];
  loop: LoopFrame[];
  sessions: SessionView[];
  activeSkills: ActiveSkillView[];
  selected?: Selection;
};

// ─── Run Header ────────────────────────────────────────────────────

export type RunHeaderView = {
  runId: string;
  status: AgentRunStatus;
  stepIndex: number;
  maxSteps: number;
  cwd: string;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
};

// ─── Conversation ──────────────────────────────────────────────────

export type ConversationItem =
  | {
      kind: "user";
      timestamp: string;
      channel: string;
      text: string;
      sourceEventId?: string;
    }
  | {
      kind: "agent";
      timestamp: string;
      text: string;
      messageKind: "status" | "final" | "error";
    }
  | {
      kind: "system";
      timestamp: string;
      text: string;
    };

// ─── Loop Frames ───────────────────────────────────────────────────

export type LoopFrame = {
  id: string;
  stepIndex: number;
  timestamp: string;
  phase:
    | "model"
    | "decision"
    | "validation"
    | "review"
    | "tool"
    | "observation"
    | "environment"
    | "io_wait"
    | "skill";
  status: "pending" | "running" | "ok" | "warn" | "error" | "waiting";
  title: string;
  summary: string;
  detail?: string;
  logPath?: string;
  transcriptEventId?: string;
};

// ─── Sessions ──────────────────────────────────────────────────────

export type SessionView = {
  session: string;
  state: "idle" | "running" | "blocked" | "terminated";
  currentCommand?: string;
  returnCode?: number | null;
  logPath: string;
  tail: string;
  tailOffset?: number;
};

// ─── Active Skills ─────────────────────────────────────────────────

export type ActiveSkillView = {
  skillRunId: string;
  skill: string;
  status: "running" | "review_pending";
  executionReturnCode?: number;
  executionLogPath: string;
  reviewTaskPath?: string;
};

// ─── Selection ─────────────────────────────────────────────────────

export type Selection = {
  pane: "conversation" | "loop";
  index: number;
};

// ─── Key Input ─────────────────────────────────────────────────────

export type TuiKey = {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
};

// ─── Limits ────────────────────────────────────────────────────────

export type TuiLimits = {
  maxConversationItems: number;
  maxLoopFrames: number;
  maxFrameDetailChars: number;
  maxLogTailLines: number;
};

export const DEFAULT_TUI_LIMITS: TuiLimits = {
  maxConversationItems: 200,
  maxLoopFrames: 500,
  maxFrameDetailChars: 2000,
  maxLogTailLines: 200,
};

// ─── Renderer Interface ────────────────────────────────────────────

export type TuiRenderer = {
  render(view: TuiViewModel): void;
  onKey(handler: (key: TuiKey) => void): void;
  close(): void;
};

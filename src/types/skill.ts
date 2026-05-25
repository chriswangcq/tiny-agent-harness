// ─── Skill Types ────────────────────────────────────────────────────
//
// Skill package, manifest, run lifecycle, and persistent reminder types.

import type { JsonSchema } from "./tools.js";

// ─── Skill Manifest ─────────────────────────────────────────────────

export type SkillManifest = {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  entry?: string;
  argsSchema?: JsonSchema;
  outputContract?: "text" | "json" | "file";
};

// ─── Skill Run Lifecycle ────────────────────────────────────────────

export type SkillRunStatus = "running" | "review_pending" | "closed";

export type SkillRunState = {
  skillRunId: string;
  skill: string;
  status: SkillRunStatus;

  startedAt: string;
  closedAt?: string;

  args?: unknown;
  executionReturnCode?: number;
  executionLogPath: string;

  statePath: string;
  reviewTaskPath?: string;
  lessonsPath?: string;
};

// ─── Active Skill Run Summary (for system reminder) ─────────────────

export type ActiveSkillRunSummary = {
  skillRunId: string;
  skill: string;
  status: "running" | "review_pending";
  executionReturnCode?: number;
  executionLogPath: string;
  reviewTaskPath?: string;
};

// ─── Persistent Reminder Fact ───────────────────────────────────────

export type PersistentReminderFact = {
  kind: "active_skill_run";
  skillRunId: string;
  skill: string;
  status: "running" | "review_pending";
  executionReturnCode?: number;
  executionLogPath: string;
  reviewTaskPath?: string;
};

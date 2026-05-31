import type { ToolRequest, ToolReviewDecision } from "../types/index.js";
import {
  evaluateToolPolicy,
  type ToolPolicyOptions,
} from "./policy.js";

// ---------------------------------------------------------------------------
// AlwaysApproveReviewer
// ---------------------------------------------------------------------------

export class AlwaysApproveReviewer {
  async review(_request: ToolRequest): Promise<ToolReviewDecision> {
    return {
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve",
    };
  }
}

export class ToolPolicyReviewer {
  constructor(private readonly options: ToolPolicyOptions = {}) {}

  async review(request: ToolRequest): Promise<ToolReviewDecision> {
    const decision = evaluateToolPolicy(request, this.options);

    return {
      status: decision.status,
      reason: decision.reason,
      reviewer: "tool-policy",
      ...(decision.warnings.length > 0 ? { warnings: decision.warnings } : {}),
    };
  }
}

import type { ToolRequest, ToolReviewDecision } from "../types/index.js";

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

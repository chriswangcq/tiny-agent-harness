import { describe, it, expect } from "vitest";
import { ViewModelBuilder } from "../src/tui/view-model-builder.js";
import { buildLoopFrameDetail } from "../src/tui/debugger.js";
import type { LoopFrame } from "../src/tui/types.js";
import type {
  RunEvent,
  ToolRequest,
  ToolReviewDecision,
} from "../src/types/run.js";

function makeToolRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  return {
    toolCallId: "call-001",
    toolName: "terminal_write",
    inputSeq: 1,
    ...overrides,
  } as ToolRequest;
}

function makeReviewDecision(
  overrides: Partial<ToolReviewDecision> = {},
): ToolReviewDecision {
  return {
    status: "approved",
    reason: "always approve",
    reviewer: "always-approve",
    ...overrides,
  };
}

describe("P012 review/control panel display", () => {
  describe("pendingReview in RunHeaderView", () => {
    it("is false when no review events exist", () => {
      const builder = new ViewModelBuilder();
      for (const ev of [
        {
          type: "run_started",
          runId: "run-1",
          stepIndex: 0,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/repo",
        } satisfies RunEvent,
      ]) builder.applyEvent(ev as RunEvent);
      const vm = builder.getViewModel();
      expect(vm.run.pendingReview).toBe(false);
    });

    it("becomes true after tool_review_requested", () => {
      const builder = new ViewModelBuilder();
      for (const ev of [
        {
          type: "run_started",
          runId: "run-1",
          stepIndex: 0,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/repo",
        } satisfies RunEvent,
        {
          type: "tool_review_requested",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          timestamp: "2026-01-01T00:00:01Z",
        } satisfies RunEvent,
      ]) builder.applyEvent(ev as RunEvent);
      const vm = builder.getViewModel();
      expect(vm.run.pendingReview).toBe(true);
    });

    it("returns to false after matching tool_reviewed", () => {
      const builder = new ViewModelBuilder();
      for (const ev of [
        {
          type: "run_started",
          runId: "run-1",
          stepIndex: 0,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/repo",
        } satisfies RunEvent,
        {
          type: "tool_review_requested",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          timestamp: "2026-01-01T00:00:01Z",
        } satisfies RunEvent,
        {
          type: "tool_reviewed",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          decision: makeReviewDecision(),
          timestamp: "2026-01-01T00:00:02Z",
        } satisfies RunEvent,
      ]) builder.applyEvent(ev as RunEvent);
      const vm = builder.getViewModel();
      expect(vm.run.pendingReview).toBe(false);
    });

    it("stays true when only some reviews are matched", () => {
      const builder = new ViewModelBuilder();
      for (const ev of [
        {
          type: "run_started",
          runId: "run-1",
          stepIndex: 0,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/repo",
        } satisfies RunEvent,
        {
          type: "tool_review_requested",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          timestamp: "2026-01-01T00:00:01Z",
        } satisfies RunEvent,
        {
          type: "tool_review_requested",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-002" }),
          timestamp: "2026-01-01T00:00:01Z",
        } satisfies RunEvent,
        {
          type: "tool_reviewed",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          decision: makeReviewDecision(),
          timestamp: "2026-01-01T00:00:02Z",
        } satisfies RunEvent,
      ]) builder.applyEvent(ev as RunEvent);
      const vm = builder.getViewModel();
      expect(vm.run.pendingReview).toBe(true);
    });
  });

  describe("controlAffordance on loop frames", () => {
    it("sets R on review_requested frames", () => {
      const builder = new ViewModelBuilder();
      for (const ev of [
        {
          type: "run_started",
          runId: "run-1",
          stepIndex: 0,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/repo",
        } satisfies RunEvent,
        {
          type: "tool_review_requested",
          stepIndex: 1,
          request: makeToolRequest(),
          timestamp: "2026-01-01T00:00:01Z",
        } satisfies RunEvent,
      ]) builder.applyEvent(ev as RunEvent);
      const vm = builder.getViewModel();
      const reviewFrames = vm.loop.filter((f) => f.phase === "review");
      expect(reviewFrames.length).toBeGreaterThan(0);
      expect(reviewFrames[0].controlAffordance).toBe("R");
    });

    it("does NOT set controlAffordance on tool_reviewed frames (review complete)", () => {
      const builder = new ViewModelBuilder();
      for (const ev of [
        {
          type: "run_started",
          runId: "run-1",
          stepIndex: 0,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/repo",
        } satisfies RunEvent,
        {
          type: "tool_review_requested",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          timestamp: "2026-01-01T00:00:01Z",
        } satisfies RunEvent,
        {
          type: "tool_reviewed",
          stepIndex: 1,
          request: makeToolRequest({ toolCallId: "call-001" }),
          decision: makeReviewDecision(),
          timestamp: "2026-01-01T00:00:02Z",
        } satisfies RunEvent,
      ]) builder.applyEvent(ev as RunEvent);
      const vm = builder.getViewModel();
      const reviewFrames = vm.loop.filter((f) => f.phase === "review");
      // The review_requested frame has R, reviewed frame does NOT
      const requestedFrame = reviewFrames.find((f) => f.title === "review requested");
      const reviewedFrame = reviewFrames.find((f) => f.title === "approved");
      expect(requestedFrame?.controlAffordance).toBe("R");
      expect(reviewedFrame?.controlAffordance).toBeUndefined();
    });
  });

  describe("riskReason in LoopFrameDetail", () => {
    it("includes riskReason when reviewDecision has findings", () => {
      const frame: LoopFrame = {
        id: "frame-1",
        stepIndex: 1,
        timestamp: "2026-01-01T00:00:00Z",
        phase: "review",
        status: "ok",
        title: "approved",
        summary: "test",
        reviewDecision: makeReviewDecision({
          reason: "Network access detected",
          findings: [
            {
              code: "NET_ACCESS",
              severity: "warning",
              message: "Tool may access network",
            },
            {
              code: "HIGH_RISK",
              severity: "error",
              message: "Potential dangerous operation",
            },
          ],
        }),
      };
      const detail = buildLoopFrameDetail(frame);
      expect(detail.riskReason).toBeDefined();
      expect(detail.riskReason!).toContain("Network access detected");
      expect(detail.riskReason!).toContain("[warning]");
      expect(detail.riskReason!).toContain("[error]");
      expect(detail.riskReason!).toContain("Tool may access network");
    });

    it("riskReason falls back to status when no reason or findings", () => {
      const frame: LoopFrame = {
        id: "frame-1",
        stepIndex: 1,
        timestamp: "2026-01-01T00:00:00Z",
        phase: "review",
        status: "warn",
        title: "rejected",
        summary: "test",
        reviewDecision: makeReviewDecision({
          reason: "",
          findings: [],
        }),
      };
      const detail = buildLoopFrameDetail(frame);
      expect(detail.riskReason).toBe("approved");
    });

    it("does not include riskReason when reviewDecision is absent", () => {
      const frame: LoopFrame = {
        id: "frame-1",
        stepIndex: 1,
        timestamp: "2026-01-01T00:00:00Z",
        phase: "tool",
        status: "ok",
        title: "test",
        summary: "test",
      };
      const detail = buildLoopFrameDetail(frame);
      expect(detail.riskReason).toBeUndefined();
    });
  });
});

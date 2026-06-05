import { describe, it, expect } from "vitest";
import {
  planTuiLayout,
  planTopRightSplit,
  TuiLayoutPlan,
} from "../src/tui/renderer.js";

function makePlan(width: number, bodyHeight: number): TuiLayoutPlan {
  return planTuiLayout({ width, bodyHeight });
}

describe("planTuiLayout boundary conditions", () => {
  it("produces non-negative widths at minimum screen (40x10)", () => {
    const plan = makePlan(40, 10);
    expect(plan.conversationPaneWidth).toBeGreaterThanOrEqual(0);
    expect(plan.rightWidth).toBeGreaterThanOrEqual(0);
    expect(plan.loopPaneWidth).toBeGreaterThanOrEqual(0);
    expect(plan.detailPaneWidth).toBeGreaterThanOrEqual(0);
    expect(plan.topHeight).toBeGreaterThanOrEqual(0);
    expect(plan.bottomHeight).toBeGreaterThanOrEqual(0);
    // Sum should equal total width
    expect(plan.conversationPaneWidth + plan.rightWidth).toBe(40);
  });

  it("handles very narrow screen (20x10)", () => {
    const plan = makePlan(20, 10);
    expect(plan.conversationPaneWidth).toBeGreaterThanOrEqual(0);
    expect(plan.rightWidth).toBeGreaterThanOrEqual(0);
    expect(plan.conversationPaneWidth + plan.rightWidth).toBe(20);
    // At 20 cols, left width should fill
    expect(plan.rightWidth).toBe(0);
    expect(plan.loopPaneWidth).toBe(0);
    expect(plan.detailPaneWidth).toBe(0);
  });

  it("handles minimum width of 1", () => {
    const plan = makePlan(1, 5);
    expect(plan.conversationPaneWidth).toBe(1);
    expect(plan.rightWidth).toBe(0);
    expect(plan.topHeight).toBeGreaterThanOrEqual(0);
    expect(plan.bottomHeight).toBeGreaterThanOrEqual(0);
    expect(plan.topHeight + plan.bottomHeight).toBe(5); // bodyHeight = 5
  });

  it("handles extremely wide screen (300 cols)", () => {
    const plan = makePlan(300, 50);
    expect(plan.conversationPaneWidth).toBeGreaterThanOrEqual(0);
    expect(plan.rightWidth).toBeGreaterThanOrEqual(0);
    expect(plan.conversationPaneWidth + plan.rightWidth).toBe(300);
    expect(plan.loopPaneWidth + plan.detailPaneWidth).toBe(plan.rightWidth);
  });

  it("handles minimum body height (1)", () => {
    const plan = makePlan(80, 1);
    expect(plan.topHeight).toBeGreaterThanOrEqual(0);
    expect(plan.bottomHeight).toBeGreaterThanOrEqual(0);
    expect(plan.topHeight + plan.bottomHeight).toBe(1); // bodyHeight = 1
  });

  it("zero-width right column collapses loop and detail", () => {
    const plan = makePlan(30, 20);
    // At 30 cols, chooseLeftWidth returns 30, so rightWidth = 0
    expect(plan.rightWidth).toBe(0);
    expect(plan.loopPaneWidth).toBe(0);
    expect(plan.detailPaneWidth).toBe(0);
  });

  it("loop and detail widths sum to rightWidth when rightWidth > 0", () => {
    const plan = makePlan(120, 30);
    expect(plan.rightWidth).toBeGreaterThan(0);
    expect(plan.loopPaneWidth + plan.detailPaneWidth).toBe(plan.rightWidth);
  });

  it("PTY viewport with very large cols is clamped to screen width", () => {
    const plan = planTuiLayout({
      width: 60,
      bodyHeight: 30,
      ptyViewport: { cols: 200, rows: 50 },
    });
    expect(plan.rightWidth).toBeLessThanOrEqual(60);
    expect(plan.rightWidth).toBe(60);
    expect(plan.conversationPaneWidth).toBe(0);
  });

  it("PTY height exceeding body is clamped", () => {
    const plan = planTuiLayout({
      width: 120,
      bodyHeight: 10,
      ptyViewport: { cols: 80, rows: 60 },
    });
    expect(plan.bottomHeight).toBeLessThanOrEqual(10);
    expect(plan.bottomHeight).toBe(10);
    expect(plan.topHeight).toBe(0);
    expect(plan.ptyFitsViewport).toBe(false);
  });

  it("zero ptyViewport rows and cols produce sane layout", () => {
    const plan = planTuiLayout({
      width: 100,
      bodyHeight: 30,
      ptyViewport: { cols: 0, rows: 0 },
    });
    // requiredPtyWidth = 0 + 2 = 2, requiredPtyHeight = 0 + 2 = 2
    // rightWidth = clampNumber(Math.max(preferredRightWidth, 2), 0, 100)
    expect(plan.rightWidth).toBeGreaterThanOrEqual(2);
    expect(plan.bottomHeight).toBeGreaterThanOrEqual(2);
  });
});

describe("planTopRightSplit", () => {
  it("returns zero widths for zero rightWidth", () => {
    const split = planTopRightSplit(0);
    expect(split.loopPaneWidth).toBe(0);
    expect(split.detailPaneWidth).toBe(0);
  });

  it("returns zero widths for negative rightWidth", () => {
    const split = planTopRightSplit(-5);
    expect(split.loopPaneWidth).toBe(0);
    expect(split.detailPaneWidth).toBe(0);
  });

  it("gives all width to loop at small rightWidth (< 24)", () => {
    const split = planTopRightSplit(20);
    expect(split.loopPaneWidth).toBe(20);
    expect(split.detailPaneWidth).toBe(0);
  });

  it("splits proportionally at 51% for large rightWidth", () => {
    const split = planTopRightSplit(100);
    expect(split.loopPaneWidth).toBe(51);
    expect(split.detailPaneWidth).toBe(49);
    expect(split.loopPaneWidth + split.detailPaneWidth).toBe(100);
  });

  it("detailPaneWidth is at least 12 when rightWidth >= 24", () => {
    const split = planTopRightSplit(24);
    // loopPaneWidth = clampNumber(12, 12, 12) = 12
    expect(split.loopPaneWidth).toBe(12);
    expect(split.detailPaneWidth).toBe(12);
  });
});

describe("TuiLayoutPlan invariants", () => {
  function testInvariants(width: number, bodyHeight: number) {
    const plan = planTuiLayout({ width, bodyHeight });
    it(`layout at ${width}x${bodyHeight} satisfies invariants`, () => {
      // All widths >= 0
      expect(plan.conversationPaneWidth).toBeGreaterThanOrEqual(0);
      expect(plan.rightWidth).toBeGreaterThanOrEqual(0);
      expect(plan.loopPaneWidth).toBeGreaterThanOrEqual(0);
      expect(plan.detailPaneWidth).toBeGreaterThanOrEqual(0);
      expect(plan.topHeight).toBeGreaterThanOrEqual(0);
      expect(plan.bottomHeight).toBeGreaterThanOrEqual(0);

      // Width sum
      expect(plan.conversationPaneWidth + plan.rightWidth).toBe(width);

      // Height sum (bodyHeight = height - 1, so topHeight + bottomHeight = bodyHeight)
      expect(plan.topHeight + plan.bottomHeight).toBe(bodyHeight);

      // Right split sum
      expect(plan.loopPaneWidth + plan.detailPaneWidth).toBe(plan.rightWidth);
    });
  }

  testInvariants(40, 10);
  testInvariants(80, 24);
  testInvariants(120, 40);
  testInvariants(1, 1);
  testInvariants(200, 60);
  testInvariants(41, 15);
});

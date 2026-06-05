import { describe, it, expect } from "vitest";
import { evaluateToolPolicy, type ToolPolicyOptions } from "../../src/tools/policy.js";
import { ToolPolicyReviewer } from "../../src/tools/reviewer.js";
import type { ToolRequest } from "../../src/types/tools.js";

function makeTerminalWrite(text: string, expectedInputSeq = 1): ToolRequest {
  return {
    toolCallId: "call-1",
    toolName: "terminal_write",
    request: { kind: "terminal_write", expectedInputSeq, text },
  };
}

function makeTerminalKey(key: "enter" = "enter"): ToolRequest {
  return {
    toolCallId: "call-2",
    toolName: "terminal_key",
    request: { kind: "terminal_key", key },
  };
}

function makeSessionObserve(): ToolRequest {
  return {
    toolCallId: "call-3",
    toolName: "session_observe",
    request: {},
  };
}

describe("evaluateToolPolicy", () => {
  it("approves safe terminal_write with no dangerous patterns", () => {
    const result = evaluateToolPolicy(makeTerminalWrite("echo hello\n"));
    expect(result.status).toBe("approved");
    expect(result.reason).toContain("Approved by tool policy");
    expect(result.warnings).toEqual([]);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "safe_terminal_write", severity: "info" }),
      ])
    );
    // riskReasons populated from all findings
    expect(result.riskReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "safe_terminal_write",
          severity: "info",
          description: expect.any(String),
        }),
      ])
    );
  });

  it("rejects dangerous recursive delete", () => {
    const result = evaluateToolPolicy(makeTerminalWrite("rm -rf /\n"));
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Rejected by tool policy");
    expect(result.findings.some((f) => f.code === "dangerous_recursive_delete")).toBe(true);
    expect(result.riskReasons.some((r) => r.code === "dangerous_recursive_delete")).toBe(true);
  });

  it("rejects overlong terminal_write", () => {
    const longText = "x".repeat(40_000);
    const result = evaluateToolPolicy(makeTerminalWrite(longText));
    expect(result.status).toBe("rejected");
    expect(result.findings.some((f) => f.code === "dangerous_overlong_input")).toBe(true);
    expect(result.riskReasons.some((r) => r.code === "dangerous_overlong_input")).toBe(true);
  });

  it("approves with warnings for curl (warning_network_transfer)", () => {
    const result = evaluateToolPolicy(makeTerminalWrite("curl https://example.com\n"));
    expect(result.status).toBe("approved");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toContain(
      "Network transfer command may fetch unreviewed remote content."
    );
    expect(result.findings.some((f) => f.code === "warning_network_transfer")).toBe(true);
    expect(result.riskReasons.some((r) => r.code === "warning_network_transfer")).toBe(true);
  });

  it("approves terminal_key with safe_terminal_key finding", () => {
    const result = evaluateToolPolicy(makeTerminalKey("enter"));
    expect(result.status).toBe("approved");
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "safe_terminal_key", severity: "info" }),
    ]);
    expect(result.riskReasons).toEqual([
      expect.objectContaining({ code: "safe_terminal_key", severity: "info" }),
    ]);
  });

  it("approves session_observe with safe_session_tool finding", () => {
    const result = evaluateToolPolicy(makeSessionObserve());
    expect(result.status).toBe("approved");
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "safe_session_tool", severity: "info" }),
    ]);
    expect(result.riskReasons).toEqual([
      expect.objectContaining({ code: "safe_session_tool", severity: "info" }),
    ]);
  });

  it("allows dangerous writes when allowDangerousTerminalWrites is true", () => {
    const options: ToolPolicyOptions = { allowDangerousTerminalWrites: true };
    const result = evaluateToolPolicy(makeTerminalWrite("rm -rf /\n"), options);
    expect(result.status).toBe("approved");
    // dangerous findings are downgraded to warning severity in riskReasons
    const dangerousInRisk = result.riskReasons.find((r) => r.code === "dangerous_recursive_delete");
    expect(dangerousInRisk).toBeDefined();
    expect(dangerousInRisk!.severity).toBe("warning");
  });

  it("rejects sudo rm (dangerous_privileged_command)", () => {
    const result = evaluateToolPolicy(makeTerminalWrite("sudo rm -rf /tmp\n"));
    expect(result.status).toBe("rejected");
    expect(result.findings.some((f) => f.code === "dangerous_privileged_command")).toBe(true);
    expect(result.riskReasons.some((r) => r.code === "dangerous_privileged_command")).toBe(true);
  });
});

describe("ToolPolicyReviewer", () => {
  it("maps evaluator decision to ToolReviewDecision with riskReasons", async () => {
    const reviewer = new ToolPolicyReviewer();
    const decision = await reviewer.review(makeTerminalWrite("echo safe\n"));
    expect(decision.status).toBe("approved");
    expect(decision.reviewer).toBe("tool-policy");
    expect(decision.reason).toContain("Approved by tool policy");
    expect(decision.findings).toBeDefined();
    expect(decision.riskReasons).toBeDefined();
    expect(decision.riskReasons!.length).toBeGreaterThan(0);
    expect(decision.riskReasons![0]).toMatchObject({
      code: "safe_terminal_write",
      severity: "info",
    });
  });

  it("maps rejected decision with warnings and riskReasons", async () => {
    const reviewer = new ToolPolicyReviewer();
    const decision = await reviewer.review(makeTerminalWrite("rm -rf /\n"));
    expect(decision.status).toBe("rejected");
    expect(decision.reviewer).toBe("tool-policy");
    expect(decision.findings!.some((f) => f.severity === "error")).toBe(true);
    expect(decision.riskReasons!.some((r) => r.severity === "error")).toBe(true);
  });
});

describe("ToolReviewDecision riskReasons display boundary", () => {
  it("riskReasons is separate from the reason summary string", async () => {
    // The riskReasons field is structured data for audit;
    // the reason string is the user-facing summary.
    const reviewer = new ToolPolicyReviewer();
    const decision = await reviewer.review(makeTerminalWrite("curl https://example.com\n"));
    // riskReasons has machine-readable codes
    expect(decision.riskReasons!.some((r) => r.code === "warning_network_transfer")).toBe(true);
    // reason string is human-readable summary
    expect(decision.reason).toContain("warning(s)");
    // riskReasons should NOT be embedded in the reason string
    expect(decision.reason).not.toContain("warning_network_transfer");
  });

  it("findings and riskReasons are parallel audit fields", async () => {
    const reviewer = new ToolPolicyReviewer();
    const decision = await reviewer.review(makeTerminalWrite("rm -rf /\n"));
    expect(decision.findings).toBeDefined();
    expect(decision.riskReasons).toBeDefined();
    // Both arrays should have same length (one riskReason per finding)
    expect(decision.riskReasons!.length).toBe(decision.findings!.length);
    // Each finding has a corresponding riskReason with same code
    decision.findings!.forEach((f) => {
      const match = decision.riskReasons!.find((r) => r.code === f.code);
      expect(match).toBeDefined();
      expect(match!.severity).toBe(f.severity);
    });
  });
});

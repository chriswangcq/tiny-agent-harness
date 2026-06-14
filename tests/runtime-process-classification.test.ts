import { describe, expect, it } from "vitest";
import {
  EDGER_CLI_OPERATION_KINDS,
  STATEFUL_RUNTIME_PROCESS_KINDS,
  classifyEdgerCliOperation,
  classifyRuntimeProcessKind,
  isStatefulRuntimeProcessKind,
  type RuntimeProcessKind,
} from "../src/runtime/index.js";

const CURRENT_PROCESS_KINDS: RuntimeProcessKind[] = [
  "run",
  "terminal-host",
  "pty-session",
  "codeq-host",
  "skill-host",
  "mcp-host",
  "model-gateway",
];

describe("runtime process classification", () => {
  it("classifies every current process kind as an independent stateful subprocess", () => {
    expect(STATEFUL_RUNTIME_PROCESS_KINDS).toEqual(CURRENT_PROCESS_KINDS);

    for (const kind of CURRENT_PROCESS_KINDS) {
      const classification = classifyRuntimeProcessKind(kind);
      expect(classification).toMatchObject({
        kind,
        residency: "stateful-subprocess",
      });
      expect(classification.liveResources.length).toBeGreaterThan(0);
      expect(classification.durableStateOwner.length).toBeGreaterThan(0);
      expect(classification.reason.length).toBeGreaterThan(0);
    }
  });

  it("recognizes runtime process kinds without accepting edger names", () => {
    expect(isStatefulRuntimeProcessKind("run")).toBe(true);
    expect(isStatefulRuntimeProcessKind("im-channel")).toBe(false);
    expect(isStatefulRuntimeProcessKind("team-roster")).toBe(false);
  });

  it("classifies representative file-backed edger CLI operations", () => {
    expect(EDGER_CLI_OPERATION_KINDS).toContain("im-channel");
    expect(EDGER_CLI_OPERATION_KINDS).toContain("team-roster");
    expect(EDGER_CLI_OPERATION_KINDS).toContain("process-registry");

    expect(classifyEdgerCliOperation("im-channel")).toMatchObject({
      operation: "im-channel",
      residency: "one-shot-edger-cli",
      durableStateOwner: "im/",
    });
    expect(classifyEdgerCliOperation("team-roster")).toMatchObject({
      operation: "team-roster",
      residency: "one-shot-edger-cli",
      durableStateOwner: "teams/<teamId>/events.jsonl",
    });
  });
});

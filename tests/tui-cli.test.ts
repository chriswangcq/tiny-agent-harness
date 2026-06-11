import { describe, expect, it } from "vitest";
import { buildTuiControllerOptions } from "../src/cli/tui.js";

describe("buildTuiControllerOptions", () => {
  it("passes public IM state and endpoints to TuiController options", () => {
    const options = buildTuiControllerOptions({
      runDir: "/repo/.tiny-agent/runs/run-1",
      runsDir: "/repo/.tiny-agent/runs",
      stateRoot: "/repo/.tiny-agent",
      runId: "run-1",
      env: {},
    });

    expect(options).toEqual({
      runDir: "/repo/.tiny-agent/runs/run-1",
      runsDir: "/repo/.tiny-agent/runs",
      stateRoot: "/repo/.tiny-agent",
      runId: "run-1",
      selfEndpoint: "run:run-1",
      userEndpoint: "user:main",
    });
  });

  it("uses explicit public IM endpoint env overrides", () => {
    const options = buildTuiControllerOptions({
      runDir: "/repo/.tiny-agent/runs/run-2",
      runsDir: "/repo/.tiny-agent/runs",
      stateRoot: "/repo/.tiny-agent",
      runId: "run-2",
      env: {
        TAH_IM_SELF_ENDPOINT: "member:team-p6/coder-1",
        TAH_IM_USER_ENDPOINT: "user:operator",
      },
    });

    expect(options.selfEndpoint).toBe("member:team-p6/coder-1");
    expect(options.userEndpoint).toBe("user:operator");
  });
});

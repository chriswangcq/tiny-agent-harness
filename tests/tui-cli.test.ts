import { describe, expect, it } from "vitest";
import { buildTuiControllerOptions } from "../src/cli/tui.js";

describe("buildTuiControllerOptions", () => {
  it("passes the explicit runsDir to TuiController options", () => {
    const options = buildTuiControllerOptions({
      runDir: "/repo/.tiny-agent/runs/run-1",
      runsDir: "/repo/.tiny-agent/runs",
      channel: "ops",
      env: {},
    });

    expect(options).toEqual({
      runDir: "/repo/.tiny-agent/runs/run-1",
      runsDir: "/repo/.tiny-agent/runs",
      imBaseDir: "/repo/.tiny-agent/runs/run-1/im",
      channel: "ops",
    });
  });

  it("uses TAH_IM_CHANNEL when no channel flag is provided", () => {
    const options = buildTuiControllerOptions({
      runDir: "/repo/.tiny-agent/runs/run-2",
      runsDir: "/repo/.tiny-agent/runs",
      env: { TAH_IM_CHANNEL: "from-env" },
    });

    expect(options.channel).toBe("from-env");
  });

  it("defaults channel when neither flag nor env is provided", () => {
    const options = buildTuiControllerOptions({
      runDir: "/repo/.tiny-agent/runs/run-3",
      runsDir: "/repo/.tiny-agent/runs",
      env: {},
    });

    expect(options.channel).toBe("default");
  });
});

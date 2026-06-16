import { describe, expect, it } from "vitest";
import {
  buildProjectUiControllerOptions,
  parseProjectUiCliArgs,
} from "../src/cli/ui.js";

describe("buildProjectUiControllerOptions", () => {
  it("passes only the runtime socket boundary to the project UI controller", () => {
    const options = buildProjectUiControllerOptions({
      runtimeSocketPath: "/tmp/ta-rh/runtime-edge.sock",
    });

    expect(options).toEqual({
      runtimeSocketPath: "/tmp/ta-rh/runtime-edge.sock",
    });
  });
});

describe("parseProjectUiCliArgs", () => {
  it("accepts only project UI flags at the outer CLI boundary", () => {
    expect(parseProjectUiCliArgs(["--state-dir", "/tmp/state"])).toEqual({
      stateDir: "/tmp/state",
      help: false,
      unexpectedArgs: [],
    });
  });

  it("rejects old run-bound launch arguments", () => {
    expect(parseProjectUiCliArgs(["--task", "fix tests"]).unexpectedArgs).toEqual([
      "--task",
      "fix tests",
    ]);
    expect(parseProjectUiCliArgs(["--run", "run-1"]).unexpectedArgs).toEqual([
      "--run",
      "run-1",
    ]);
    expect(parseProjectUiCliArgs(["--resume", "latest"]).unexpectedArgs).toEqual([
      "--resume",
      "latest",
    ]);
  });
});

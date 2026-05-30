import { describe, it, expect } from "vitest";
import { cleanEnv, buildCliTerminalEnv } from "../src/cli/terminal-env.js";

describe("cleanEnv", () => {
  it("keeps string values", () => {
    const result = cleanEnv({ PATH: "/usr/bin", HOME: "/home/user" });
    expect(result).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
  });

  it("drops undefined values", () => {
    const result = cleanEnv({ PATH: "/usr/bin", GONE: undefined as unknown as string } as NodeJS.ProcessEnv);
    expect(result).toEqual({ PATH: "/usr/bin" });
    expect("GONE" in result).toBe(false);
  });
});

describe("buildCliTerminalEnv", () => {
  it("sets TAH_RUN_CHANNEL when absent", () => {
    const result = buildCliTerminalEnv({ PATH: "/usr/bin" }, "default");
    expect(result.TAH_RUN_CHANNEL).toBe("default");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("overwrites existing TAH_RUN_CHANNEL", () => {
    const result = buildCliTerminalEnv({ PATH: "/bin", TAH_RUN_CHANNEL: "stale" }, "default");
    expect(result.TAH_RUN_CHANNEL).toBe("default");
    expect(result.PATH).toBe("/bin");
  });

  it("uses different channels", () => {
    const result = buildCliTerminalEnv({}, "cli");
    expect(result.TAH_RUN_CHANNEL).toBe("cli");
  });

  it("drops undefined env values", () => {
    const result = buildCliTerminalEnv({ PATH: "/bin", GONE: undefined as unknown as string } as NodeJS.ProcessEnv, "default");
    expect(result.PATH).toBe("/bin");
    expect("GONE" in result).toBe(false);
    expect(result.TAH_RUN_CHANNEL).toBe("default");
  });
});

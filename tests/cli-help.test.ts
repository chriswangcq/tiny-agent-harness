import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("main CLI help", () => {
  it("documents supported subcommands without removed payload transport", () => {
    const help = execFileSync(
      process.execPath,
      ["--loader", "ts-node/esm", "src/cli/main.ts", "--help"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(help).toContain("tiny-agent im  <subcommand>");
    expect(help).toContain("tiny-agent skill <subcommand>");
    expect(help).not.toContain(["rece", "iver"].join(""));
    expect(help).not.toContain(["max", "-frame-bytes"].join(""));
  });
});

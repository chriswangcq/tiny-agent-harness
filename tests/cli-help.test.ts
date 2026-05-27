import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("main CLI help", () => {
  it("documents receiver file and IM target forms", () => {
    const help = execFileSync(
      process.execPath,
      ["--loader", "ts-node/esm", "src/cli/main.ts", "--help"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(help).toContain("tiny-agent receiver <subcommand>");
    expect(help).toContain("start  --target file --path <path>");
    expect(help).toContain("start  --target im --channel <ch> --kind <status|error>");
  });
});

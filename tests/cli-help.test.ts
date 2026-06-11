import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../src/cli/help-text.js";

describe("main CLI help", () => {
  it("help text documents supported subcommands and excludes removed features", () => {
    expect(HELP_TEXT).toContain("tiny-agent im  <subcommand>");
    expect(HELP_TEXT).toContain("tiny-agent skill <subcommand>");
    expect(HELP_TEXT).toContain("tiny-agent codeq <subcommand>");
    expect(HELP_TEXT).toContain("tiny-agent team <group>");
    expect(HELP_TEXT).toContain("tiny-agent ui  --resume <runId|latest>");
    expect(HELP_TEXT).toContain("team lifecycle <subcommand>");
    expect(HELP_TEXT).toContain("terminal/session tools");
    expect(HELP_TEXT).not.toContain("tiny-agent file <subcommand>");
    expect(HELP_TEXT).not.toContain("cat <stashId>");
    expect(HELP_TEXT).not.toContain(["rece", "iver"].join(""));
    expect(HELP_TEXT).not.toContain(["max", "-frame-bytes"].join(""));
  });

  it("--help flag writes help text to stdout", () => {
    const help = execFileSync(
      process.execPath,
      ["--loader", "ts-node/esm", "src/cli/main.ts", "--help"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    // The output should match the canonical HELP_TEXT
    expect(help).toBe(HELP_TEXT);
  });

  it("main bin entry has a node shebang for npm link", () => {
    const source = readFileSync("src/cli/main.ts", "utf8");
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});

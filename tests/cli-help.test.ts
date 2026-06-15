import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../src/cli/help-text.js";

describe("main CLI help", () => {
  it("help text documents supported subcommands and excludes removed features", () => {
    expect(HELP_TEXT).toContain("tiny-agent im  <subcommand>");
    expect(HELP_TEXT).toContain("tiny-agent skill <subcommand>");
    expect(HELP_TEXT).toContain("tiny-agent codeq <subcommand>");
    expect(HELP_TEXT).toContain("tiny-agent team <group>");
    expect(HELP_TEXT).toContain("TAH_IM_HOST_SOCKET");
    expect(HELP_TEXT).toContain("tiny-agent im admin post");
    expect(HELP_TEXT).toContain("tiny-agent im send --kind <status|error> --text-stdin");
    expect(HELP_TEXT).toContain("tiny-agent <task>");
    expect(HELP_TEXT).toContain("Alias for tiny-agent run --task <task>");
    expect(HELP_TEXT).toContain("tiny-agent ui  --resume <runId|latest>");
    expect(HELP_TEXT).toContain("team lifecycle <subcommand>");
    expect(HELP_TEXT).toContain("terminal/session tools");
    expect(HELP_TEXT).not.toContain("Run with inline task");
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

  it("rejects unquoted multi-word positional task aliases", () => {
    const result = spawnSync(
      process.execPath,
      ["--loader", "ts-node/esm", "src/cli/main.ts", "fix", "tests"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("tiny-agent <task> accepts exactly one task argument");
    expect(result.stderr).toContain('tiny-agent run --task "<task>"');
  });

  it("main bin entry has a node shebang for npm link", () => {
    const source = readFileSync("src/cli/main.ts", "utf8");
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});

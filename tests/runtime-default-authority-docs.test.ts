import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("runtime default authority documentation", () => {
  const defaultAuthorityDocs = [
    "docs/runtime-process-architecture.md",
    "docs/run-orchestrator-state.md",
    "docs/project-report.md",
    "docs/tui.md",
    "docs/state-storage-locking.md",
    "docs/environment-model.md",
  ];

  it("does not describe ManagedTerminalRuntime as the default run-process terminal owner", () => {
    const docs = defaultAuthorityDocs.map((file) =>
      fs.readFileSync(path.resolve(file), "utf-8"),
    );

    for (const doc of docs) {
      expect(doc).not.toMatch(/ManagedTerminalRuntime owns PTY sessions/);
      expect(doc).not.toMatch(/ManagedTerminalRuntime 是 session raw log owner/);
      expect(doc).not.toMatch(/still uses the in-process terminal runtime by default/);
      expect(doc).not.toMatch(/ORCH --> BASH\["ManagedTerminalRuntime"\]/);
    }
  });

  it("does not describe DeepSeekFimAdapter as the default run-process model owner", () => {
    const docs = defaultAuthorityDocs.map((file) =>
      fs.readFileSync(path.resolve(file), "utf-8"),
    );

    for (const doc of docs) {
      expect(doc).not.toMatch(/The model gateway port exists but is not the default model path yet/);
      expect(doc).not.toMatch(/calls: DeepSeekFimAdapter/);
      expect(doc).not.toMatch(/\+-> DeepSeekFimAdapter/);
      expect(doc).not.toMatch(/ORCH --> MODEL\["DeepSeek FIM Adapter"\]/);
    }
  });

  it("documents TerminalHost and ModelGateway as default run authorities", () => {
    const architecture = fs.readFileSync(
      path.resolve("docs/runtime-process-architecture.md"),
      "utf-8",
    );

    expect(architecture).toMatch(
      /`Terminal Host` owns PTY sessions, screen buffers, visual-line cursors, and/,
    );
    expect(architecture).toMatch(
      /`Model gateway` owns the default run `ModelPort` boundary/,
    );
    expect(architecture).toContain("tiny-agent model-gateway");
    expect(architecture).toContain("tiny-agent terminal-host");
  });

  it("documents team supervisor ownership above runs", () => {
    const docs = [
      "docs/README.md",
      "docs/state-layout.md",
      "docs/project-report.md",
    ].map((file) => fs.readFileSync(path.resolve(file), "utf-8"));

    for (const doc of docs) {
      expect(doc).toContain("teams/<teamId>/");
    }

    const stateLayout = docs[1]!;
    expect(stateLayout).toContain("teams/<teamId>/supervisor/lifecycle-events.jsonl");
    expect(stateLayout).toContain("teams/<teamId>/members/<memberId>/state.json");
  });
});

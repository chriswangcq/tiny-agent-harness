import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
  runtimeReplicaPaths,
  residentHostPaths,
} from "../src/runtime/index.js";

describe("CLI main runtime replica wiring", () => {
  const source = readFileSync("src/cli/main.ts", "utf8");

  it("does not construct direct PublicImService state in the run process", () => {
    expect(source).not.toMatch(/\bPublicImService\b/);
    expect(source).not.toContain("createNodeImStore");
    expect(source).not.toContain("createCliRunImService");
  });

  it("passes the run-owned runtime replica socket into run polling and terminal env", () => {
    expect(source).toContain("const runtimeReplicaSocketPath = runtimeReplica.socketPath;");
    expect(source).toMatch(
      /receivePublicRunUserMessages\(\{\s*socketPath: runtimeReplicaSocketPath,\s*runId,/s,
    );
    expect(source).toMatch(
      /ackPublicRunUserMessage\(\{\s*socketPath: runtimeReplicaSocketPath,\s*runId,\s*messageId: message\.id,/s,
    );
    expect(source).toMatch(
      /createCliTerminalHost\(\{\s*runId,[\s\S]*runtimeHostSocket: runtimeReplicaSocketPath,/,
    );
  });

  it("ensures the runtime replica before run IM binding", () => {
    expect(source).toMatch(
      /runtimeReplica = await ensureRuntimeReplica\(\{[\s\S]*runId,[\s\S]*stateDir: baseDir,/,
    );
    expect(source).toMatch(
      /ensureDefaultRunImBinding\(\{\s*socketPath: runtimeReplica\.socketPath,\s*runId,/,
    );
    expect(source).not.toContain("createCliImHost");
    expect(source).not.toContain('"im",\n    "host"');
  });

  it("threads resident socket root and scope into runtime and downstream host wiring", () => {
    expect(source).toContain(
      "const residentSocketRoot = defaultResidentSocketRoot({ tmpDir: os.tmpdir() });",
    );
    expect(source).toContain("const residentSocketScope = baseDir;");
    expect(source).toMatch(
      /runtimeReplicaPaths\(\{\s*runDir,\s*runId,[\s\S]*socketRoot: residentSocketRoot,[\s\S]*socketScope: residentSocketScope,/,
    );
    expect(source).toMatch(
      /createCliTerminalHost\(\{\s*runId,\s*runDir,\s*residentSocketRoot,\s*residentSocketScope,[\s\S]*runtimeHostSocket: runtimeReplicaSocketPath,/,
    );
    expect(source).toMatch(
      /kind: "terminal-host",[\s\S]*runDir: options\.runDir,[\s\S]*socketRoot: options\.residentSocketRoot,[\s\S]*socketScope: options\.residentSocketScope,/,
    );
  });

  it("uses short generated socket paths for runtime replicas and downstream host identities", () => {
    const baseDir = path.join(
      "/state",
      "projects",
      "very-long-cli-project-state-root-".repeat(5),
    );
    const runId = "run-1781231813968";
    const runDir = path.join(baseDir, "runs", runId);
    const socketRoot = "/tmp/ta-rh-test";

    const runtimePaths = runtimeReplicaPaths({
      runDir,
      runId,
      socketRoot,
      socketScope: baseDir,
    });
    const terminalPaths = residentHostPaths({
      kind: "terminal-host",
      runId,
      runDir,
      socketRoot,
      socketScope: baseDir,
    });

    for (const paths of [runtimePaths, terminalPaths]) {
      expect(paths.socketPath).toMatch(/^\/tmp\/ta-rh-test\/[a-z]+-[a-f0-9]{16}\.sock$/);
      expect(paths.socketPath).not.toContain(runDir);
      expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(
        RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
      );
    }
    expect(runtimePaths.statePath).toBe(path.join(runDir, "runtime-replica.json"));
    expect(terminalPaths.statePath).toBe(path.join(runDir, "terminal-host.json"));
  });
});

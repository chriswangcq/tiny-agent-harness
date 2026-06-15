import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("CLI main IM host wiring", () => {
  const source = readFileSync("src/cli/main.ts", "utf8");

  it("does not construct direct PublicImService state in the run process", () => {
    expect(source).not.toMatch(/\bPublicImService\b/);
    expect(source).not.toContain("createNodeImStore");
    expect(source).not.toContain("createCliRunImService");
  });

  it("passes the launched im-host socket into run polling and terminal env", () => {
    expect(source).toContain("const imHostSocketPath = imHost.socketPath;");
    expect(source).toMatch(
      /receivePublicRunUserMessages\(\{\s*socketPath: imHostSocketPath,\s*runId,/s,
    );
    expect(source).toMatch(
      /ackPublicRunUserMessage\(\{\s*socketPath: imHostSocketPath,\s*runId,\s*messageId: message\.id,/s,
    );
    expect(source).toMatch(
      /createCliTerminalHost\(\{\s*runId,[\s\S]*imHostSocket: imHostSocketPath,/,
    );
  });

  it("starts im host with explicit state, run, self, and user arguments", () => {
    expect(source).toMatch(
      /"im",\s*"host",[\s\S]*"--socket",[\s\S]*"--state-dir",[\s\S]*"--run-id",[\s\S]*"--self",[\s\S]*"--user",/,
    );
  });
});

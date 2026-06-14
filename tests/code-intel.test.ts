import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeCodeIntelClientArgv, type CodeIntelClientRequest } from "../src/code-intel/cli.js";
import { defaultConfig } from "../src/code-intel/config.js";
import { createCodeIntelRuntime, executeCodeIntelArgv, parseCodeIntelArgv } from "../src/code-intel/commands.js";
import { parseSourceLocation } from "../src/code-intel/location.js";
import { parseTscDiagnosticLine } from "../src/code-intel/tsc-diagnostics.js";
import type { CodeIntelEnvelope } from "../src/code-intel/types.js";

const tmpDirs: string[] = [];
const originalProjectStateDir = process.env.TAH_PROJECT_STATE_DIR;

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
  if (originalProjectStateDir === undefined) {
    delete process.env.TAH_PROJECT_STATE_DIR;
  } else {
    process.env.TAH_PROJECT_STATE_DIR = originalProjectStateDir;
  }
});

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-intel-test-"));
  tmpDirs.push(dir);
  const stateRoot = path.join(dir, "state-root");
  process.env.TAH_PROJECT_STATE_DIR = stateRoot;

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n", "utf-8");
  fs.writeFileSync(
    path.join(dir, "src", "example.ts"),
    "export class Example {\n  run() { return 1; }\n}\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "src", "target.ts"),
    "export function other() {\n  return 1;\n}\nconst Target = other;\n",
    "utf-8",
  );

  const fakeServer = path.resolve("tests/fixtures/fake-lsp-server.mjs");
  fs.writeFileSync(
    path.join(stateRoot, "code-intel.json"),
    JSON.stringify(
      {
        languages: {
          typescript: {
            serverCommand: [process.execPath, fakeServer],
          },
        },
        limits: {
          timeoutMs: 2000,
          maxResults: 10,
          previewLines: 1,
          maxOutputBytes: 20000,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  return dir;
}

describe("code-intel location parsing", () => {
  it("parses human source locations", () => {
    expect(parseSourceLocation("src/run/orchestrator.ts:37:18")).toEqual({
      path: "src/run/orchestrator.ts",
      line: 37,
      column: 18,
    });
  });

  it("rejects malformed source locations", () => {
    expect(() => parseSourceLocation("src/file.ts")).toThrow(
      "<path>:<line>:<column>",
    );
  });
});

describe("code-intel argv parsing", () => {
  it("parses read-only commands", () => {
    expect(parseCodeIntelArgv(["references", "src/file.ts:1:2", "--include-declaration", "--json"])).toEqual({
      kind: "references",
      location: { path: "src/file.ts", line: 1, column: 2 },
      includeDeclaration: true,
    });
    expect(parseCodeIntelArgv(["workspace-symbols", "Example", "--json"])).toEqual({
      kind: "workspace-symbols",
      query: "Example",
    });
    expect(parseCodeIntelArgv(["implementations", "src/file.ts:1:2", "--json"])).toEqual({
      kind: "implementations",
      location: { path: "src/file.ts", line: 1, column: 2 },
    });
    expect(parseCodeIntelArgv(["incoming-calls", "src/file.ts:1:2", "--json"])).toEqual({
      kind: "incoming-calls",
      location: { path: "src/file.ts", line: 1, column: 2 },
    });
  });

  it("rejects apply flags because codeq is read-only", () => {
    expect(() => parseCodeIntelArgv(["references", "src/file.ts:1:2", "--apply", "--json"])).toThrow(
      "read-only",
    );
  });
});

describe("code-intel TypeScript diagnostics parser", () => {
  it("normalizes tsc diagnostic lines", () => {
    const project = makeProject();
    const diagnostic = parseTscDiagnosticLine(
      "src/example.ts(1,14): error TS2322: Type mismatch",
      project,
      1,
    );

    expect(diagnostic).toMatchObject({
      path: "src/example.ts",
      severity: "error",
      source: "typescript",
      code: "2322",
      message: "Type mismatch",
      range: {
        start: { line: 1, column: 14 },
      },
      preview: "export class Example {",
    });
  });
});

describe("code-intel public CLI client", () => {
  it("requires an explicit run-scoped host socket", async () => {
    const result = await executeCodeIntelClientArgv(
      ["capabilities", "--json"],
      {
        cwd: "/repo",
        env: {},
        timeoutMs: 1_000,
        newRequestId: () => "req-no-host",
        requestHost: async () => {
          throw new Error("requestHost should not be called without a socket");
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("server_not_found");
      expect(result.error.message).toContain("TAH_CODEQ_HOST_SOCKET");
    }
  });

  it("sends parsed commands to the configured host socket", async () => {
    let captured: CodeIntelClientRequest | undefined;
    const envelope: CodeIntelEnvelope = {
      ok: true,
      tool: "codeq",
      version: "0.1.0",
      cwd: "/repo",
      workspaceRoot: "/repo",
      query: { command: "capabilities" },
      result: { languages: [] },
      limits: defaultConfig().limits,
    };

    const result = await executeCodeIntelClientArgv(
      ["capabilities", "--json", "--host-socket", "/tmp/codeq.sock"],
      {
        cwd: "/repo",
        env: {},
        timeoutMs: 1_000,
        newRequestId: () => "req-host",
        requestHost: async (request) => {
          captured = request;
          return {
            schemaVersion: 1,
            id: request.request.id,
            ok: true,
            type: "codeq.execute.result",
            envelope,
          };
        },
      },
    );

    expect(result).toBe(envelope);
    expect(captured).toMatchObject({
      socketPath: "/tmp/codeq.sock",
      timeoutMs: 1_000,
      request: {
        schemaVersion: 1,
        id: "req-host",
        type: "codeq.execute",
        command: { kind: "capabilities" },
      },
    });
  });
});

describe("code-intel command execution core", () => {
  it("reports configured capabilities", async () => {
    const project = makeProject();
    const result = await executeCodeIntelArgv(
      ["capabilities", "--json"],
      createCodeIntelRuntime(project),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        languages: [
          {
            languageId: "typescript",
            available: true,
          },
        ],
      });
    }
  });

  it("queries symbols through the configured LSP server", async () => {
    const project = makeProject();
    const result = await executeCodeIntelArgv(
      ["symbols", "src/example.ts", "--json"],
      createCodeIntelRuntime(project),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        path: "src/example.ts",
        symbols: [
          {
            name: "Example",
            kind: "class",
            children: [{ name: "run", kind: "method" }],
          },
        ],
      });
    }
  });

  it("queries workspace symbols through the configured LSP server", async () => {
    const project = makeProject();
    const result = await executeCodeIntelArgv(
      ["workspace-symbols", "Example", "--json"],
      createCodeIntelRuntime(project),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        query: "Example",
        symbols: [
          {
            name: "Example",
            kind: "class",
            path: "src/example.ts",
            range: { start: { line: 1, column: 14 } },
            containerName: "src/example.ts",
            preview: "export class Example {",
          },
          {
            name: "Target",
            kind: "constant",
            path: "src/target.ts",
            preview: "const Target = other;",
          },
        ],
      });
    }
  });

  it("queries definition, references, implementation, hover, and file diagnostics", async () => {
    const project = makeProject();
    const runtime = createCodeIntelRuntime(project);

    const definition = await executeCodeIntelArgv(
      ["definition", "src/example.ts:1:15", "--json"],
      runtime,
    );
    expect(definition.ok).toBe(true);
    if (definition.ok) {
      expect(definition.result).toMatchObject({
        definitions: [
          {
            path: "src/target.ts",
            range: { start: { line: 4, column: 8 } },
            preview: "const Target = other;",
          },
        ],
      });
    }

    const references = await executeCodeIntelArgv(
      ["references", "src/example.ts:1:15", "--json"],
      createCodeIntelRuntime(project),
    );
    expect(references.ok).toBe(true);
    if (references.ok) {
      expect(references.result).toMatchObject({
        references: [
          { path: "src/example.ts" },
          { path: "src/target.ts" },
        ],
      });
    }

    const implementations = await executeCodeIntelArgv(
      ["implementations", "src/example.ts:1:15", "--json"],
      createCodeIntelRuntime(project),
    );
    expect(implementations.ok).toBe(true);
    if (implementations.ok) {
      expect(implementations.result).toMatchObject({
        implementations: [
          {
            path: "src/target.ts",
            range: { start: { line: 1, column: 17 } },
            preview: "export function other() {",
          },
        ],
      });
    }

    const hover = await executeCodeIntelArgv(
      ["hover", "src/example.ts:1:15", "--json"],
      createCodeIntelRuntime(project),
    );
    expect(hover.ok).toBe(true);
    if (hover.ok) {
      expect(hover.result).toMatchObject({
        contents: [{ kind: "markdown", value: "class **Example**" }],
        range: { start: { line: 1, column: 14 } },
      });
    }

    const diagnostics = await executeCodeIntelArgv(
      ["diagnostics", "src/example.ts", "--json"],
      createCodeIntelRuntime(project),
    );
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok) {
      expect(diagnostics.result).toMatchObject({
        diagnostics: [
          {
            path: "src/example.ts",
            severity: "error",
            source: "fake-ts",
            code: "1001",
            message: "Fake diagnostic",
            preview: "export class Example {",
          },
        ],
      });
    }
  });

  it("queries call hierarchy through the configured LSP server", async () => {
    const project = makeProject();

    const incoming = await executeCodeIntelArgv(
      ["incoming-calls", "src/example.ts:2:3", "--json"],
      createCodeIntelRuntime(project),
    );
    expect(incoming.ok).toBe(true);
    if (incoming.ok) {
      expect(incoming.result).toMatchObject({
        items: [
          {
            name: "run",
            kind: "method",
            path: "src/example.ts",
            preview: "  run() { return 1; }",
          },
        ],
        incomingCalls: [
          {
            from: {
              name: "other",
              kind: "function",
              path: "src/target.ts",
              preview: "export function other() {",
            },
            fromRanges: [{ start: { line: 2, column: 10 } }],
          },
        ],
      });
    }

    const outgoing = await executeCodeIntelArgv(
      ["outgoing-calls", "src/example.ts:2:3", "--json"],
      createCodeIntelRuntime(project),
    );
    expect(outgoing.ok).toBe(true);
    if (outgoing.ok) {
      expect(outgoing.result).toMatchObject({
        outgoingCalls: [
          {
            to: {
              name: "Target",
              kind: "constant",
              path: "src/target.ts",
              preview: "const Target = other;",
            },
            fromRanges: [{ start: { line: 2, column: 18 } }],
          },
        ],
      });
    }
  });
});

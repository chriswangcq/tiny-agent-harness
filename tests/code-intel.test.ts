import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCodeIntelRuntime, executeCodeIntelArgv, parseCodeIntelArgv } from "../src/code-intel/commands.js";
import { parseSourceLocation } from "../src/code-intel/location.js";
import { parseTscDiagnosticLine } from "../src/code-intel/tsc-diagnostics.js";

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

describe("code-intel CLI execution", () => {
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

  it("queries definition, references, hover, and file diagnostics", async () => {
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
});

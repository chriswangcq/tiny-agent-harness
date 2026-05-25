import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { CodeIntelDiagnostic, CodeIntelLimits } from "./types.js";
import { readPreview } from "./preview.js";
import { resolveExecutable } from "./workspace.js";
import { toFileUri, workspaceRelativePath } from "./location.js";

const TSC_DIAGNOSTIC_PATTERN =
  /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/;

export function collectWorkspaceDiagnostics(input: {
  workspaceRoot: string;
  limits: CodeIntelLimits;
}): { diagnostics: CodeIntelDiagnostic[]; truncated: boolean; omittedResults: number } {
  const tsc = resolveExecutable("tsc", input.workspaceRoot);
  if (!tsc) {
    throw new Error("Could not find tsc on PATH or in local node_modules/.bin");
  }

  const result = spawnSync(tsc, ["--noEmit", "--pretty", "false"], {
    cwd: input.workspaceRoot,
    encoding: "utf-8",
  });

  if (result.error) {
    throw result.error;
  }

  const diagnostics = parseTscDiagnostics(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    input.workspaceRoot,
    input.limits.previewLines,
  );

  const limited = diagnostics.slice(0, input.limits.maxResults);
  return {
    diagnostics: limited,
    truncated: diagnostics.length > limited.length,
    omittedResults: Math.max(0, diagnostics.length - limited.length),
  };
}

export function parseTscDiagnostics(
  output: string,
  workspaceRoot: string,
  previewLines: number,
): CodeIntelDiagnostic[] {
  const diagnostics: CodeIntelDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parsed = parseTscDiagnosticLine(line, workspaceRoot, previewLines);
    if (parsed) {
      diagnostics.push(parsed);
    }
  }

  return diagnostics.sort(compareDiagnostics);
}

export function parseTscDiagnosticLine(
  line: string,
  workspaceRoot: string,
  previewLines: number,
): CodeIntelDiagnostic | undefined {
  const match = TSC_DIAGNOSTIC_PATTERN.exec(line);
  if (!match) {
    return undefined;
  }

  const [, rawPath, lineRaw, columnRaw, severityRaw, code, message] = match;
  const absolutePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(workspaceRoot, rawPath);
  const startLine = Number(lineRaw);
  const startColumn = Number(columnRaw);
  const range = {
    start: { line: startLine, column: startColumn },
    end: { line: startLine, column: startColumn + 1 },
  };

  let preview: string | undefined;
  try {
    preview = readPreview(absolutePath, range, previewLines);
  } catch {
    preview = undefined;
  }

  return {
    path: workspaceRelativePath(workspaceRoot, absolutePath),
    uri: toFileUri(absolutePath),
    range,
    severity: severityRaw === "warning" ? "warning" : "error",
    source: "typescript",
    code,
    message,
    preview,
  };
}

export function compareDiagnostics(
  left: CodeIntelDiagnostic,
  right: CodeIntelDiagnostic,
): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.path.localeCompare(right.path) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.column - right.range.start.column
  );
}

function severityRank(severity: CodeIntelDiagnostic["severity"]): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "information":
      return 2;
    case "hint":
      return 3;
  }
}

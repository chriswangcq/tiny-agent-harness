import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SourceLocation, SourcePosition, SourceRange } from "./types.js";

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export function parseSourceLocation(input: string): SourceLocation {
  const match = /^(.*):(\d+):(\d+)$/.exec(input);
  if (!match) {
    throw new Error(`Expected location in <path>:<line>:<column> format: ${input}`);
  }

  const [, filePath, lineRaw, columnRaw] = match;
  if (!filePath) {
    throw new Error(`Location path is empty: ${input}`);
  }

  const line = Number(lineRaw);
  const column = Number(columnRaw);
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`Location line must be a positive integer: ${input}`);
  }
  if (!Number.isInteger(column) || column < 1) {
    throw new Error(`Location column must be a positive integer: ${input}`);
  }

  return { path: filePath, line, column };
}

export function toLspPosition(position: SourcePosition): LspPosition {
  return {
    line: position.line - 1,
    character: position.column - 1,
  };
}

export function fromLspPosition(position: LspPosition): SourcePosition {
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

export function fromLspRange(range: LspRange): SourceRange {
  return {
    start: fromLspPosition(range.start),
    end: fromLspPosition(range.end),
  };
}

export function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function fromFileUri(uri: string): string {
  return fileURLToPath(uri);
}

export function workspaceRelativePath(
  workspaceRoot: string,
  filePath: string,
): string {
  const relative = path.relative(workspaceRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
}

export function detectLanguageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    default:
      return "plaintext";
  }
}

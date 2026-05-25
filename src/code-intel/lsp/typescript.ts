import * as fs from "node:fs";
import type {
  BackendInfo,
  CodeIntelBackend,
  CodeIntelDiagnostic,
  CodeIntelHoverContent,
  CodeIntelLimits,
  CodeIntelLocationResult,
  CodeIntelSymbol,
  SourceLocation,
} from "../types.js";
import {
  detectLanguageId,
  fromFileUri,
  fromLspRange,
  resolveWorkspacePath,
  toFileUri,
  toLspPosition,
  workspaceRelativePath,
} from "../location.js";
import { readPreview, truncateText } from "../preview.js";
import { ensureFileExists, resolveCommand } from "../workspace.js";
import { LspClient } from "./client.js";
import type {
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspSymbolInformation,
} from "./protocol.js";

const TYPESCRIPT_CAPABILITIES = [
  "diagnostics",
  "definition",
  "references",
  "documentSymbol",
  "hover",
];

export class TypeScriptLspBackend implements CodeIntelBackend {
  private client?: LspClient;
  private serverCapabilities: unknown;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      serverCommand: string[];
      initializationOptions?: unknown;
      limits: CodeIntelLimits;
    },
  ) {}

  info(): BackendInfo {
    return {
      languageId: "typescript",
      server: this.options.serverCommand[0] ?? "typescript-language-server",
      serverCommand: this.options.serverCommand,
      capabilities: TYPESCRIPT_CAPABILITIES,
      source: "lsp",
    };
  }

  async diagnostics(request: { path?: string; workspace: boolean }): Promise<{
    diagnostics: CodeIntelDiagnostic[];
  }> {
    if (request.workspace) {
      throw new Error("Workspace diagnostics are handled by the TypeScript compiler fallback");
    }
    if (!request.path) {
      throw new Error("diagnostics requires a file path unless --workspace is set");
    }

    const absolutePath = this.resolveFile(request.path);
    const uri = toFileUri(absolutePath);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const notification = await this.waitForPublishDiagnostics(uri);
    if (!notification) {
      return { diagnostics: [] };
    }

    const params = notification.params as { diagnostics?: unknown };
    const diagnostics = Array.isArray(params.diagnostics)
      ? params.diagnostics.map((diagnostic) =>
          this.normalizeDiagnostic(diagnostic as LspDiagnostic, absolutePath, uri),
        )
      : [];

    return { diagnostics: diagnostics.slice(0, this.options.limits.maxResults) };
  }

  async symbols(path: string): Promise<{ path: string; symbols: CodeIntelSymbol[] }> {
    const absolutePath = this.resolveFile(path);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const result = await this.client!.request("textDocument/documentSymbol", {
      textDocument: { uri: toFileUri(absolutePath) },
    });

    return {
      path: workspaceRelativePath(this.options.workspaceRoot, absolutePath),
      symbols: normalizeSymbols(result),
    };
  }

  async definition(location: SourceLocation): Promise<{
    definitions: CodeIntelLocationResult[];
  }> {
    const absolutePath = this.resolveFile(location.path);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const result = await this.client!.request("textDocument/definition", {
      textDocument: { uri: toFileUri(absolutePath) },
      position: toLspPosition(location),
    });

    return {
      definitions: this.normalizeLocations(result).slice(0, this.options.limits.maxResults),
    };
  }

  async references(request: {
    location: SourceLocation;
    includeDeclaration: boolean;
  }): Promise<{ references: CodeIntelLocationResult[] }> {
    const absolutePath = this.resolveFile(request.location.path);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const result = await this.client!.request("textDocument/references", {
      textDocument: { uri: toFileUri(absolutePath) },
      position: toLspPosition(request.location),
      context: { includeDeclaration: request.includeDeclaration },
    });

    return {
      references: this.normalizeLocations(result).slice(0, this.options.limits.maxResults),
    };
  }

  async hover(location: SourceLocation): Promise<{
    contents: CodeIntelHoverContent[];
    range?: ReturnType<typeof fromLspRange>;
  }> {
    const absolutePath = this.resolveFile(location.path);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const result = await this.client!.request("textDocument/hover", {
      textDocument: { uri: toFileUri(absolutePath) },
      position: toLspPosition(location),
    });

    if (!isObject(result)) {
      return { contents: [] };
    }

    const hover = result as LspHover;
    return {
      contents: normalizeHoverContents(hover.contents, this.options.limits.maxOutputBytes),
      range: hover.range ? fromLspRange(hover.range) : undefined,
    };
  }

  async dispose(): Promise<void> {
    await this.client?.shutdown();
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) {
      return;
    }

    const resolvedCommand = resolveCommand(
      this.options.serverCommand,
      this.options.workspaceRoot,
    );
    if (!resolvedCommand) {
      throw new Error(
        `Could not find ${this.options.serverCommand[0]} on PATH or in local node_modules/.bin`,
      );
    }

    this.client = new LspClient({
      command: resolvedCommand,
      cwd: this.options.workspaceRoot,
      timeoutMs: this.options.limits.timeoutMs,
    });

    const initializeResult = await this.client.initialize({
      processId: process.pid,
      rootUri: toFileUri(this.options.workspaceRoot),
      capabilities: {},
      initializationOptions: this.options.initializationOptions ?? {},
      workspaceFolders: [
        {
          uri: toFileUri(this.options.workspaceRoot),
          name: "workspace",
        },
      ],
    });
    this.serverCapabilities = isObject(initializeResult)
      ? initializeResult.capabilities
      : undefined;
  }

  private openTextDocument(absolutePath: string): void {
    const text = fs.readFileSync(absolutePath, "utf-8");
    this.client!.notify("textDocument/didOpen", {
      textDocument: {
        uri: toFileUri(absolutePath),
        languageId: detectLanguageId(absolutePath),
        version: 1,
        text,
      },
    });
  }

  private resolveFile(requestedPath: string): string {
    const absolutePath = resolveWorkspacePath(this.options.workspaceRoot, requestedPath);
    ensureFileExists(absolutePath);
    return absolutePath;
  }

  private normalizeLocations(result: unknown): CodeIntelLocationResult[] {
    const values = Array.isArray(result) ? result : result ? [result] : [];
    return values
      .map((value) => normalizeLocationLike(value))
      .filter((value): value is LspLocation => value !== undefined)
      .map((location) => {
        const absolutePath = fromFileUri(location.uri);
        const range = fromLspRange(location.range);
        let preview: string | undefined;
        try {
          preview = readPreview(absolutePath, range, this.options.limits.previewLines);
        } catch {
          preview = undefined;
        }

        return {
          path: workspaceRelativePath(this.options.workspaceRoot, absolutePath),
          uri: location.uri,
          range,
          preview,
        };
      });
  }

  private normalizeDiagnostic(
    diagnostic: LspDiagnostic,
    absolutePath: string,
    uri: string,
  ): CodeIntelDiagnostic {
    const range = fromLspRange(diagnostic.range);
    let preview: string | undefined;
    try {
      preview = readPreview(absolutePath, range, this.options.limits.previewLines);
    } catch {
      preview = undefined;
    }

    return {
      path: workspaceRelativePath(this.options.workspaceRoot, absolutePath),
      uri,
      range,
      severity: normalizeDiagnosticSeverity(diagnostic.severity),
      source: diagnostic.source,
      code:
        diagnostic.code === undefined ? undefined : String(diagnostic.code),
      message: diagnostic.message,
      preview,
    };
  }

  private async waitForPublishDiagnostics(uri: string) {
    try {
      return await this.client!.waitForNotification(
        (item) =>
          item.method === "textDocument/publishDiagnostics" &&
          isObject(item.params) &&
          item.params.uri === uri,
        Math.min(this.options.limits.timeoutMs, 3000),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Timed out waiting for LSP notification")) {
        return undefined;
      }
      throw error;
    }
  }
}

export function typescriptCapabilities(input: {
  workspaceRoot: string;
  serverCommand: string[];
}): {
  languageId: string;
  fileExtensions: string[];
  available: boolean;
  serverCommand: string[];
  capabilities: string[];
} {
  return {
    languageId: "typescript",
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
    available: resolveCommand(input.serverCommand, input.workspaceRoot) !== undefined,
    serverCommand: input.serverCommand,
    capabilities: TYPESCRIPT_CAPABILITIES,
  };
}

function normalizeSymbols(result: unknown): CodeIntelSymbol[] {
  if (!Array.isArray(result)) {
    return [];
  }

  return result.map((item) => {
    if (isDocumentSymbol(item)) {
      return {
        name: item.name,
        kind: symbolKindName(item.kind),
        range: fromLspRange(item.range),
        selectionRange: fromLspRange(item.selectionRange),
        children: item.children ? normalizeSymbols(item.children) : undefined,
      };
    }

    const symbol = item as LspSymbolInformation;
    return {
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      range: fromLspRange(symbol.location.range),
    };
  });
}

function normalizeLocationLike(value: unknown): LspLocation | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  if (typeof value.uri === "string" && isObject(value.range)) {
    return value as LspLocation;
  }

  if (typeof value.targetUri === "string" && isObject(value.targetRange)) {
    const link = value as LspLocationLink;
    return {
      uri: link.targetUri,
      range: link.targetSelectionRange ?? link.targetRange,
    };
  }

  return undefined;
}

function normalizeHoverContents(
  contents: LspHover["contents"],
  maxOutputBytes: number,
): CodeIntelHoverContent[] {
  const normalized: CodeIntelHoverContent[] = [];

  if (typeof contents === "string") {
    normalized.push({ kind: "plaintext", value: contents });
  } else if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === "string") {
        normalized.push({ kind: "plaintext", value: item });
      } else {
        normalized.push({ kind: "markdown", value: item.value });
      }
    }
  } else if (contents?.value) {
    normalized.push({ kind: contents.kind, value: contents.value });
  }

  return normalized.map((item) => ({
    ...item,
    value: truncateText(item.value, maxOutputBytes).text,
  }));
}

function normalizeDiagnosticSeverity(
  severity: number | undefined,
): CodeIntelDiagnostic["severity"] {
  switch (severity) {
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    case 1:
    default:
      return "error";
  }
}

function isDocumentSymbol(value: unknown): value is LspDocumentSymbol {
  return isObject(value) && isObject(value.selectionRange);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enumMember",
    23: "struct",
    24: "event",
    25: "operator",
    26: "typeParameter",
  };
  return names[kind] ?? `unknown:${kind}`;
}

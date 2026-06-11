import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BackendInfo,
  CodeIntelBackend,
  CodeIntelCallHierarchyItem,
  CodeIntelDiagnostic,
  CodeIntelHoverContent,
  CodeIntelIncomingCall,
  CodeIntelLimits,
  CodeIntelLocationResult,
  CodeIntelOutgoingCall,
  CodeIntelSymbol,
  CodeIntelSymbolLocation,
  SourceLocation,
  SourceRange,
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
  LspCallHierarchyIncomingCall,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspRange,
  LspSymbolInformation,
  LspWorkspaceSymbol,
} from "./protocol.js";

const TYPESCRIPT_CAPABILITIES = [
  "diagnostics",
  "definition",
  "references",
  "documentSymbol",
  "workspaceSymbol",
  "implementation",
  "callHierarchy",
  "hover",
];
const TYPESCRIPT_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const WORKSPACE_FILE_SCAN_LIMIT = 5000;

export class TypeScriptLspBackend implements CodeIntelBackend {
  private client?: LspClient;
  private readonly openedDocuments = new Set<string>();

  constructor(
    private readonly options: {
      workspaceRoot: string;
      serverCommand: string[];
      initializationOptions?: unknown;
      workspaceFiles?: string[];
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

  async workspaceSymbols(query: string): Promise<{
    query: string;
    symbols: CodeIntelSymbolLocation[];
  }> {
    await this.ensureStarted();
    this.openWorkspaceFiles();

    let symbols: CodeIntelSymbolLocation[] = [];
    try {
      const result = await this.client!.request("workspace/symbol", { query });
      symbols = this.normalizeSymbolLocations(result);
    } catch (error) {
      if (!isRecoverableWorkspaceSymbolError(error)) {
        throw error;
      }
    }

    if (symbols.length === 0) {
      symbols = await this.collectDocumentSymbols(query);
    }

    return {
      query,
      symbols: symbols.slice(
        0,
        this.options.limits.maxResults,
      ),
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

  async implementations(location: SourceLocation): Promise<{
    implementations: CodeIntelLocationResult[];
  }> {
    const absolutePath = this.resolveFile(location.path);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const result = await this.client!.request("textDocument/implementation", {
      textDocument: { uri: toFileUri(absolutePath) },
      position: toLspPosition(location),
    });

    return {
      implementations: this.normalizeLocations(result).slice(
        0,
        this.options.limits.maxResults,
      ),
    };
  }

  async incomingCalls(location: SourceLocation): Promise<{
    items: CodeIntelCallHierarchyItem[];
    incomingCalls: CodeIntelIncomingCall[];
  }> {
    const items = await this.prepareCallHierarchy(location);
    const incomingCalls: CodeIntelIncomingCall[] = [];
    for (const item of items) {
      const result = await this.client!.request("callHierarchy/incomingCalls", {
        item,
      });
      incomingCalls.push(...this.normalizeIncomingCalls(result));
    }

    return {
      items: items
        .map((item) => this.normalizeCallHierarchyItem(item))
        .filter((item): item is CodeIntelCallHierarchyItem => item !== undefined),
      incomingCalls: incomingCalls.slice(0, this.options.limits.maxResults),
    };
  }

  async outgoingCalls(location: SourceLocation): Promise<{
    items: CodeIntelCallHierarchyItem[];
    outgoingCalls: CodeIntelOutgoingCall[];
  }> {
    const items = await this.prepareCallHierarchy(location);
    const outgoingCalls: CodeIntelOutgoingCall[] = [];
    for (const item of items) {
      const result = await this.client!.request("callHierarchy/outgoingCalls", {
        item,
      });
      outgoingCalls.push(...this.normalizeOutgoingCalls(result));
    }

    return {
      items: items
        .map((item) => this.normalizeCallHierarchyItem(item))
        .filter((item): item is CodeIntelCallHierarchyItem => item !== undefined),
      outgoingCalls: outgoingCalls.slice(0, this.options.limits.maxResults),
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

    await this.client.initialize({
      processId: process.pid,
      rootUri: toFileUri(this.options.workspaceRoot),
      capabilities: {
        textDocument: {
          callHierarchy: {},
          definition: { linkSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          implementation: { linkSupport: true },
          references: {},
        },
        workspace: {
          symbol: {},
        },
      },
      initializationOptions: this.options.initializationOptions ?? {},
      workspaceFolders: [
        {
          uri: toFileUri(this.options.workspaceRoot),
          name: "workspace",
        },
      ],
    });
  }

  private openTextDocument(absolutePath: string): void {
    if (this.openedDocuments.has(absolutePath)) {
      return;
    }

    const text = fs.readFileSync(absolutePath, "utf-8");
    this.client!.notify("textDocument/didOpen", {
      textDocument: {
        uri: toFileUri(absolutePath),
        languageId: detectLanguageId(absolutePath),
        version: 1,
        text,
      },
    });
    this.openedDocuments.add(absolutePath);
  }

  private openWorkspaceFiles(): void {
    let openedSourceFile = false;
    for (const workspaceFile of this.options.workspaceFiles ?? []) {
      const absolutePath = resolveWorkspacePath(
        this.options.workspaceRoot,
        workspaceFile,
      );
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        continue;
      }

      this.openTextDocument(absolutePath);
      if (isTypeScriptSourceFile(absolutePath)) {
        openedSourceFile = true;
      }
    }

    if (openedSourceFile) {
      return;
    }

    const sourceFile = findFirstWorkspaceSourceFile(this.options.workspaceRoot);
    if (sourceFile) {
      this.openTextDocument(sourceFile);
    }
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

  private normalizeSymbolLocations(result: unknown): CodeIntelSymbolLocation[] {
    if (!Array.isArray(result)) {
      return [];
    }

    return result
      .map((value) => this.normalizeSymbolLocation(value))
      .filter((value): value is CodeIntelSymbolLocation => value !== undefined);
  }

  private normalizeSymbolLocation(value: unknown): CodeIntelSymbolLocation | undefined {
    if (!isObject(value) || typeof value.name !== "string" || typeof value.kind !== "number") {
      return undefined;
    }

    const symbol = value as LspSymbolInformation | LspWorkspaceSymbol;
    const location = symbol.location as { uri?: unknown; range?: unknown };
    if (!isObject(location) || typeof location.uri !== "string") {
      return undefined;
    }

    let absolutePath: string;
    try {
      absolutePath = fromFileUri(location.uri);
    } catch {
      return undefined;
    }

    const range = isLspRange(location.range)
      ? fromLspRange(location.range)
      : undefined;
    let preview: string | undefined;
    if (range) {
      try {
        preview = readPreview(absolutePath, range, this.options.limits.previewLines);
      } catch {
        preview = undefined;
      }
    }

    return {
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      path: workspaceRelativePath(this.options.workspaceRoot, absolutePath),
      uri: location.uri,
      range,
      containerName: symbol.containerName,
      preview,
    };
  }

  private async prepareCallHierarchy(
    location: SourceLocation,
  ): Promise<LspCallHierarchyItem[]> {
    const absolutePath = this.resolveFile(location.path);
    await this.ensureStarted();
    this.openTextDocument(absolutePath);

    const result = await this.client!.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: toFileUri(absolutePath) },
      position: toLspPosition(location),
    });

    if (!Array.isArray(result)) {
      return [];
    }

    return result.filter(isCallHierarchyItem);
  }

  private normalizeIncomingCalls(result: unknown): CodeIntelIncomingCall[] {
    if (!Array.isArray(result)) {
      return [];
    }

    return result
      .map((value) => {
        if (!isObject(value) || !isCallHierarchyItem(value.from)) {
          return undefined;
        }
        const call = value as LspCallHierarchyIncomingCall;
        const from = this.normalizeCallHierarchyItem(call.from);
        if (!from) {
          return undefined;
        }
        return {
          from,
          fromRanges: normalizeRanges(call.fromRanges),
        };
      })
      .filter((value): value is CodeIntelIncomingCall => value !== undefined);
  }

  private normalizeOutgoingCalls(result: unknown): CodeIntelOutgoingCall[] {
    if (!Array.isArray(result)) {
      return [];
    }

    return result
      .map((value) => {
        if (!isObject(value) || !isCallHierarchyItem(value.to)) {
          return undefined;
        }
        const call = value as LspCallHierarchyOutgoingCall;
        const to = this.normalizeCallHierarchyItem(call.to);
        if (!to) {
          return undefined;
        }
        return {
          to,
          fromRanges: normalizeRanges(call.fromRanges),
        };
      })
      .filter((value): value is CodeIntelOutgoingCall => value !== undefined);
  }

  private normalizeCallHierarchyItem(
    item: LspCallHierarchyItem,
  ): CodeIntelCallHierarchyItem | undefined {
    let absolutePath: string;
    try {
      absolutePath = fromFileUri(item.uri);
    } catch {
      return undefined;
    }

    const range = fromLspRange(item.range);
    let preview: string | undefined;
    try {
      preview = readPreview(absolutePath, range, this.options.limits.previewLines);
    } catch {
      preview = undefined;
    }

    return {
      name: item.name,
      kind: symbolKindName(item.kind),
      path: workspaceRelativePath(this.options.workspaceRoot, absolutePath),
      uri: item.uri,
      range,
      selectionRange: fromLspRange(item.selectionRange),
      detail: item.detail,
      preview,
    };
  }

  private async collectDocumentSymbols(
    query: string,
  ): Promise<CodeIntelSymbolLocation[]> {
    const symbols: CodeIntelSymbolLocation[] = [];
    const files = findWorkspaceSourceFiles(this.options.workspaceRoot);
    for (const file of files) {
      if (symbols.length >= this.options.limits.maxResults) {
        break;
      }

      this.openTextDocument(file);
      const result = await this.client!.request("textDocument/documentSymbol", {
        textDocument: { uri: toFileUri(file) },
      });
      symbols.push(
        ...this.documentSymbolsToLocations(file, normalizeSymbols(result), query),
      );
    }

    return symbols;
  }

  private documentSymbolsToLocations(
    absolutePath: string,
    symbols: CodeIntelSymbol[],
    query: string,
    containerName?: string,
  ): CodeIntelSymbolLocation[] {
    const normalizedQuery = query.toLowerCase();
    const results: CodeIntelSymbolLocation[] = [];
    for (const symbol of symbols) {
      if (symbol.name.toLowerCase().includes(normalizedQuery)) {
        let preview: string | undefined;
        try {
          preview = readPreview(
            absolutePath,
            symbol.selectionRange ?? symbol.range,
            this.options.limits.previewLines,
          );
        } catch {
          preview = undefined;
        }

        results.push({
          name: symbol.name,
          kind: symbol.kind,
          path: workspaceRelativePath(this.options.workspaceRoot, absolutePath),
          uri: toFileUri(absolutePath),
          range: symbol.selectionRange ?? symbol.range,
          containerName,
          preview,
        });
      }

      if (symbol.children) {
        results.push(
          ...this.documentSymbolsToLocations(
            absolutePath,
            symbol.children,
            query,
            symbol.name,
          ),
        );
      }
    }

    return results;
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

function normalizeRanges(ranges: unknown): SourceRange[] {
  if (!Array.isArray(ranges)) {
    return [];
  }

  return ranges
    .filter(isLspRange)
    .map((range) => fromLspRange(range));
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

function isRecoverableWorkspaceSymbolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No Project") ||
    message.includes("workspace/symbol") ||
    message.includes("not supported")
  );
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

function isCallHierarchyItem(value: unknown): value is LspCallHierarchyItem {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "number" &&
    typeof value.uri === "string" &&
    isLspRange(value.range) &&
    isLspRange(value.selectionRange)
  );
}

function isLspRange(value: unknown): value is LspRange {
  return (
    isObject(value) &&
    isObject(value.start) &&
    isObject(value.end) &&
    typeof value.start.line === "number" &&
    typeof value.start.character === "number" &&
    typeof value.end.line === "number" &&
    typeof value.end.character === "number"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findFirstWorkspaceSourceFile(workspaceRoot: string): string | undefined {
  return findWorkspaceSourceFiles(workspaceRoot, 1)[0];
}

function findWorkspaceSourceFiles(
  workspaceRoot: string,
  maxFiles = WORKSPACE_FILE_SCAN_LIMIT,
): string[] {
  const ignoredDirectories = new Set([
    ".git",
    ".tiny-agent",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const pending = [workspaceRoot];
  const matches: string[] = [];
  let visited = 0;

  while (
    pending.length > 0 &&
    visited < WORKSPACE_FILE_SCAN_LIMIT &&
    matches.length < maxFiles
  ) {
    const current = pending.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          pending.push(entryPath);
        }
        continue;
      }

      if (entry.isFile() && isTypeScriptSourceFile(entryPath)) {
        matches.push(entryPath);
        if (matches.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return matches;
}

function isTypeScriptSourceFile(filePath: string): boolean {
  return TYPESCRIPT_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

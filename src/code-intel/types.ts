export type CodeIntelCommand =
  | { kind: "capabilities" }
  | { kind: "diagnostics"; path?: string; workspace: boolean }
  | { kind: "symbols"; path: string }
  | { kind: "definition"; location: SourceLocation }
  | { kind: "references"; location: SourceLocation; includeDeclaration: boolean }
  | { kind: "hover"; location: SourceLocation };

export type SourceLocation = {
  path: string;
  line: number;
  column: number;
};

export type SourcePosition = {
  line: number;
  column: number;
};

export type SourceRange = {
  start: SourcePosition;
  end: SourcePosition;
};

export type CodeIntelLimits = {
  timeoutMs: number;
  maxResults: number;
  previewLines: number;
  maxOutputBytes: number;
  truncated?: boolean;
  omittedResults?: number;
};

export type BackendInfo = {
  languageId: string;
  server: string;
  serverCommand: string[];
  capabilities: string[];
  source?: "lsp" | "typescript-compiler";
};

export type BackendCapabilities = {
  languages: Array<{
    languageId: string;
    fileExtensions: string[];
    available: boolean;
    serverCommand: string[];
    capabilities: string[];
  }>;
};

export type CodeIntelQuery =
  | { command: "capabilities" }
  | { command: "diagnostics"; path?: string; workspace: boolean }
  | { command: "symbols"; path: string }
  | { command: "definition"; location: SourceLocation }
  | { command: "references"; location: SourceLocation; includeDeclaration: boolean }
  | { command: "hover"; location: SourceLocation };

export type CodeIntelErrorCode =
  | "invalid_args"
  | "unsupported_language"
  | "server_not_found"
  | "server_start_failed"
  | "server_timeout"
  | "server_crashed"
  | "capability_missing"
  | "file_not_found"
  | "parse_location_failed"
  | "request_failed"
  | "output_truncated";

export type CodeIntelError = {
  code: CodeIntelErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export type CodeIntelSuccess<T = unknown> = {
  ok: true;
  tool: "codeq";
  version: string;
  cwd: string;
  workspaceRoot: string;
  configPath?: string;
  backend?: BackendInfo;
  query: CodeIntelQuery;
  result: T;
  limits: CodeIntelLimits;
  warnings?: string[];
};

export type CodeIntelFailure = {
  ok: false;
  tool: "codeq";
  version: string;
  cwd: string;
  workspaceRoot?: string;
  configPath?: string;
  error: CodeIntelError;
};

export type CodeIntelEnvelope<T = unknown> =
  | CodeIntelSuccess<T>
  | CodeIntelFailure;

export type CodeIntelDiagnostic = {
  path: string;
  uri: string;
  range: SourceRange;
  severity: "error" | "warning" | "information" | "hint";
  source?: string;
  code?: string;
  message: string;
  preview?: string;
};

export type CodeIntelSymbol = {
  name: string;
  kind: string;
  range: SourceRange;
  selectionRange?: SourceRange;
  children?: CodeIntelSymbol[];
};

export type CodeIntelLocationResult = {
  path: string;
  uri: string;
  range: SourceRange;
  preview?: string;
};

export type CodeIntelHoverContent = {
  kind: "markdown" | "plaintext";
  value: string;
};

export type CodeIntelBackend = {
  info(): BackendInfo;
  diagnostics(request: { path?: string; workspace: boolean }): Promise<{
    diagnostics: CodeIntelDiagnostic[];
  }>;
  symbols(path: string): Promise<{ path: string; symbols: CodeIntelSymbol[] }>;
  definition(location: SourceLocation): Promise<{
    definitions: CodeIntelLocationResult[];
  }>;
  references(request: {
    location: SourceLocation;
    includeDeclaration: boolean;
  }): Promise<{ references: CodeIntelLocationResult[] }>;
  hover(location: SourceLocation): Promise<{
    contents: CodeIntelHoverContent[];
    range?: SourceRange;
  }>;
  dispose(): Promise<void>;
};

export type CodeIntelConfig = {
  defaultLanguage: "typescript";
  languages: {
    typescript: {
      extensions: string[];
      serverCommand: string[];
      initializationOptions?: unknown;
      workspaceFiles?: string[];
    };
  };
  limits: CodeIntelLimits;
};

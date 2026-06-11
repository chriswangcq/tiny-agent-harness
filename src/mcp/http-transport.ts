import type { JsonRpcTransport } from "./transport.js";

type FetchLike = typeof fetch;

export interface HttpMcpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  mode?: "http" | "sse";
  protocolVersion?: string;
  fetchImpl?: FetchLike;
}

type SseEventHandler = (event: string, data: string) => void;

/**
 * Remote MCP transport.
 *
 * "http" implements the Streamable HTTP MCP transport. "sse" implements the
 * older HTTP+SSE compatibility path where GET yields an endpoint event and
 * POSTs are sent to that endpoint.
 */
export class HttpMcpTransport implements JsonRpcTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly mode: "http" | "sse";
  private readonly protocolVersion: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<(code: number | null) => void> = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];
  private readonly abortControllers = new Set<AbortController>();
  private sessionId: string | undefined;
  private legacyPostUrl: string | undefined;
  private legacyReady: Promise<void> | undefined;
  private resolveLegacyReady: (() => void) | undefined;
  private rejectLegacyReady: ((err: Error) => void) | undefined;
  private sendQueue = Promise.resolve();
  private destroyed = false;
  private closedEmitted = false;

  constructor(options: HttpMcpTransportOptions) {
    if (!options.url) {
      throw new Error("Remote MCP transport requires a url");
    }
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.mode = options.mode ?? "http";
    this.protocolVersion = options.protocolVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (this.mode === "sse") {
      this.legacyReady = new Promise((resolve, reject) => {
        this.resolveLegacyReady = resolve;
        this.rejectLegacyReady = reject;
      });
      void this.connectLegacySse();
    }
  }

  write(data: string): void {
    for (const raw of data.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      this.sendQueue = this.sendQueue
        .then(() => this.writeOne(raw))
        .catch((err: unknown) => {
          if (this.destroyed && isAbortError(err)) return;
          this.emitError(toError(err));
        });
    }
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: (code: number | null) => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.emitClose(null);
  }

  private async writeOne(raw: string): Promise<void> {
    if (this.mode === "sse") {
      await this.postLegacy(raw);
    } else {
      await this.postStreamable(raw);
    }
  }

  private async postStreamable(raw: string): Promise<void> {
    const response = await this.fetchWithAbort(this.url, {
      method: "POST",
      headers: this.requestHeaders({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      }),
      body: raw,
    });
    this.captureSession(response);
    await this.consumeResponse(response);
  }

  private async connectLegacySse(): Promise<void> {
    try {
      const response = await this.fetchWithAbort(this.url, {
        method: "GET",
        headers: this.requestHeaders({ Accept: "text/event-stream" }),
      });
      if (!response.ok) {
        throw new Error(`MCP SSE GET failed: HTTP ${response.status} ${response.statusText}`);
      }
      await this.consumeSseResponse(response, (event, data) => {
        if (!this.legacyPostUrl && event === "endpoint") {
          this.legacyPostUrl = new URL(data.trim(), this.url).toString();
          this.resolveLegacyReady?.();
          return;
        }
        if (data.trim()) this.emitData(data);
      });
      if (!this.legacyPostUrl) {
        throw new Error("MCP SSE stream closed before endpoint event");
      }
    } catch (err) {
      const error = toError(err);
      this.rejectLegacyReady?.(error);
      if (!(this.destroyed && isAbortError(err))) this.emitError(error);
    } finally {
      this.emitClose(null);
    }
  }

  private async postLegacy(raw: string): Promise<void> {
    await this.legacyReady;
    if (!this.legacyPostUrl) {
      throw new Error("MCP SSE endpoint was not established");
    }
    const response = await this.fetchWithAbort(this.legacyPostUrl, {
      method: "POST",
      headers: this.requestHeaders({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      }),
      body: raw,
    });
    await this.consumeResponse(response);
  }

  private async consumeResponse(response: Response): Promise<void> {
    if (response.status === 202) return;
    if (!response.ok) {
      throw new Error(await formatHttpError("MCP HTTP request failed", response));
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await this.consumeSseResponse(response, (_event, data) => {
        if (data.trim()) this.emitData(data);
      });
      return;
    }

    const text = await response.text();
    if (text.trim()) this.emitData(text);
  }

  private async consumeSseResponse(
    response: Response,
    onEvent: SseEventHandler,
  ): Promise<void> {
    if (!response.body) {
      processSseText(await response.text(), onEvent);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.destroyed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSseBuffer(buffer, onEvent);
    }
    buffer += decoder.decode();
    processSseText(buffer, onEvent);
  }

  private async fetchWithAbort(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    if (this.destroyed) throw new Error("MCP HTTP transport closed");
    const controller = new AbortController();
    this.abortControllers.add(controller);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  private requestHeaders(extra: Record<string, string>): Record<string, string> {
    const headers = { ...this.headers, ...extra };
    if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return headers;
  }

  private captureSession(response: Response): void {
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
  }

  private emitData(text: string): void {
    const line = text.endsWith("\n") ? text : text + "\n";
    const chunk = Buffer.from(line, "utf-8");
    for (const handler of this.dataHandlers) handler(chunk);
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) handler(err);
  }

  private emitClose(code: number | null): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    for (const handler of this.closeHandlers) handler(code);
  }
}

function drainSseBuffer(buffer: string, onEvent: SseEventHandler): string {
  const normalized = buffer.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  let cursor = 0;
  while (true) {
    const boundary = normalized.indexOf("\n\n", cursor);
    if (boundary === -1) break;
    dispatchSseFrame(normalized.slice(cursor, boundary), onEvent);
    cursor = boundary + 2;
  }
  return normalized.slice(cursor);
}

function processSseText(text: string, onEvent: SseEventHandler): void {
  const rest = drainSseBuffer(text, onEvent);
  if (rest.trim()) dispatchSseFrame(rest, onEvent);
}

function dispatchSseFrame(frame: string, onEvent: SseEventHandler): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length > 0) onEvent(event, dataLines.join("\n"));
}

async function formatHttpError(prefix: string, response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const snippet = body.trim().slice(0, 500);
  return `${prefix}: HTTP ${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ""}`;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

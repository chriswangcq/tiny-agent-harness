import type { RuntimeImResponse } from "../im/protocol.js";
import type { TuiViewModel } from "../tui/types.js";
import type { ProjectSnapshotResult } from "./project-snapshot.js";

export type WorkbenchCursor = string;

export type WorkbenchConnectRequest = {
  schemaVersion: 1;
  id: string;
  type: "workbench.connect";
  clientId?: string;
  cursor?: WorkbenchCursor;
};

export type WorkbenchSubscribeRequest = {
  schemaVersion: 1;
  id: string;
  type: "workbench.subscribe";
  clientId?: string;
  selectedRunId?: string;
  cursor?: WorkbenchCursor;
};

export type WorkbenchReplayRequest = {
  schemaVersion: 1;
  id: string;
  type: "workbench.replay";
  cursor?: WorkbenchCursor;
};

export type WorkbenchSnapshotRequest = {
  schemaVersion: 1;
  id: string;
  type: "workbench.snapshot";
  selectedRunId?: string;
};

export type WorkbenchCommandRequest = {
  schemaVersion: 1;
  id: string;
  type: "workbench.command";
  clientId?: string;
  command: WorkbenchCommand;
};

export type WorkbenchRequest =
  | WorkbenchConnectRequest
  | WorkbenchSubscribeRequest
  | WorkbenchReplayRequest
  | WorkbenchSnapshotRequest
  | WorkbenchCommandRequest;

export type WorkbenchCommand =
  | {
      kind: "send-message";
      text: string;
    }
  | {
      kind: "create-run";
      task?: string;
    }
  | {
      kind: "resume-run";
      runId: string;
    }
  | {
      kind: "stop-run";
      runId?: string;
    }
  | {
      kind: "open-run";
      runId: string;
    }
  | {
      kind: "refresh";
    };

export type WorkbenchViewUpdated = {
  kind: "view.updated";
  reason:
    | "connect"
    | "subscribe"
    | "snapshot"
    | "replay"
    | "send-message"
    | "create-run"
    | "resume-run"
    | "stop-run"
    | "open-run"
    | "refresh";
  selectedRunId?: string;
  view: TuiViewModel;
};

export type WorkbenchEvent = WorkbenchViewUpdated;

export type WorkbenchEventMessage = {
  schemaVersion: 1;
  id: string;
  type: "workbench.event";
  eventSeq: number;
  cursor: WorkbenchCursor;
  event: WorkbenchEvent;
};

export type WorkbenchResultResponse = {
  schemaVersion: 1;
  id: string;
  ok: true;
  type: "workbench.result";
  command: WorkbenchRequest["type"];
  data: Record<string, unknown>;
};

export type WorkbenchErrorResponse = {
  schemaVersion: 1;
  id: string;
  ok: false;
  type: "workbench.error";
  error: {
    code: "BAD_REQUEST" | "WORKBENCH_ERROR";
    message: string;
  };
};

export type WorkbenchResponse = WorkbenchResultResponse | WorkbenchErrorResponse;

export type WorkbenchServerMessage = WorkbenchResponse | WorkbenchEventMessage;

export type WorkbenchClientPort = {
  send(message: WorkbenchServerMessage): void;
  onClose(handler: () => void): void;
};

export type WorkbenchPushDelivery = {
  clientId: string;
  event: WorkbenchEventMessage;
  port: WorkbenchClientPort;
};

export type WorkbenchBackendPort = {
  snapshot(input: { selectedRunId?: string }): Promise<ProjectSnapshotResult>;
  postUserMessage(input: {
    runId: string;
    from: string;
    to: string;
    text: string;
    metadata?: Record<string, string>;
  }): Promise<Record<string, unknown> | RuntimeImResponse>;
  createRun(input: { task?: string }): Promise<{ runId: string }>;
  startRun(input: {
    runId: string;
  }): Promise<{ runId: string; alreadyRunning?: boolean }>;
  stopRun(input: {
    runId: string;
  }): Promise<{
    runId: string;
    stopped: boolean;
    processId?: string;
    reason?: "not-running";
  }>;
};

export type ProjectWorkbenchServiceDeps = {
  backend: WorkbenchBackendPort;
  userEndpoint: string;
  runEndpoint: (runId: string) => string;
  nowIso: () => string;
  newClientId: () => string;
  newEventId: () => string;
  maxEventLogSize?: number;
};

type WorkbenchClientState = {
  clientId: string;
  selectedRunId?: string;
  port?: WorkbenchClientPort;
  lastViewFingerprint?: string;
};

export type WorkbenchHandleResult = {
  response: WorkbenchResponse;
  events: WorkbenchEventMessage[];
};

export class ProjectWorkbenchService {
  private readonly backend: WorkbenchBackendPort;
  private readonly userEndpoint: string;
  private readonly runEndpoint: (runId: string) => string;
  private readonly nowIso: () => string;
  private readonly newClientId: () => string;
  private readonly newEventId: () => string;
  private readonly maxEventLogSize: number;
  private readonly clients = new Map<string, WorkbenchClientState>();
  private readonly eventLog: WorkbenchEventMessage[] = [];
  private nextEventSeq = 0;

  constructor(deps: ProjectWorkbenchServiceDeps) {
    this.backend = deps.backend;
    this.userEndpoint = deps.userEndpoint;
    this.runEndpoint = deps.runEndpoint;
    this.nowIso = deps.nowIso;
    this.newClientId = deps.newClientId;
    this.newEventId = deps.newEventId;
    this.maxEventLogSize = deps.maxEventLogSize ?? 500;
  }

  async handleRequest(
    request: WorkbenchRequest,
    port?: WorkbenchClientPort,
  ): Promise<WorkbenchHandleResult> {
    try {
      switch (request.type) {
        case "workbench.connect":
          return await this.connect(request, port);
        case "workbench.subscribe":
          return await this.subscribe(request, port);
        case "workbench.replay":
          return this.replay(request);
        case "workbench.snapshot":
          return await this.snapshot(request);
        case "workbench.command":
          return await this.command(request);
      }
    } catch (error) {
      return {
        response: workbenchErrorResponse({
          id: request.id,
          code: "WORKBENCH_ERROR",
          message: error instanceof Error ? error.message : String(error),
        }),
        events: [],
      };
    }
  }

  async refreshClientView(input: {
    clientId: string;
    reason: WorkbenchViewUpdated["reason"];
  }): Promise<WorkbenchEventMessage> {
    const client = this.requireClient(input.clientId);
    return requireWorkbenchEvent(
      await this.emitClientView(client, input.reason, { emitUnchanged: true }),
    );
  }

  async refreshSubscribedViews(input: {
    reason?: WorkbenchViewUpdated["reason"];
  } = {}): Promise<WorkbenchPushDelivery[]> {
    const deliveries: WorkbenchPushDelivery[] = [];
    for (const client of this.clients.values()) {
      if (!client.port) {
        continue;
      }
      const event = await this.emitClientView(client, input.reason ?? "refresh", {
        emitUnchanged: false,
      });
      if (event) {
        deliveries.push({
          clientId: client.clientId,
          event,
          port: client.port,
        });
      }
    }
    return deliveries;
  }

  private async connect(
    request: WorkbenchConnectRequest,
    port: WorkbenchClientPort | undefined,
  ): Promise<WorkbenchHandleResult> {
    const client = this.upsertClient({
      clientId: request.clientId,
      port,
    });
    const events = this.eventsAfter(request.cursor);
    return {
      response: workbenchResultResponse({
        id: request.id,
        command: request.type,
        data: {
          clientId: client.clientId,
          cursor: this.currentCursor(),
          replayCount: events.length,
        },
      }),
      events,
    };
  }

  private async subscribe(
    request: WorkbenchSubscribeRequest,
    port: WorkbenchClientPort | undefined,
  ): Promise<WorkbenchHandleResult> {
    const client = this.upsertClient({
      clientId: request.clientId,
      selectedRunId: request.selectedRunId,
      port,
    });
    const events = [
      ...this.eventsAfter(request.cursor),
      requireWorkbenchEvent(
        await this.emitClientView(client, "subscribe", { emitUnchanged: true }),
      ),
    ];
    return {
      response: workbenchResultResponse({
        id: request.id,
        command: request.type,
        data: {
          clientId: client.clientId,
          selectedRunId: client.selectedRunId,
          cursor: this.currentCursor(),
          eventCount: events.length,
        },
      }),
      events,
    };
  }

  private replay(request: WorkbenchReplayRequest): WorkbenchHandleResult {
    const events = this.eventsAfter(request.cursor);
    return {
      response: workbenchResultResponse({
        id: request.id,
        command: request.type,
        data: {
          cursor: this.currentCursor(),
          events,
          eventCount: events.length,
        },
      }),
      events: [],
    };
  }

  private async snapshot(
    request: WorkbenchSnapshotRequest,
  ): Promise<WorkbenchHandleResult> {
    const snapshot = await this.backend.snapshot({
      selectedRunId: request.selectedRunId,
    });
    const event = this.appendViewEvent({
      kind: "view.updated",
      reason: "snapshot",
      selectedRunId: snapshot.selectedRunId,
      view: snapshot.view,
    });
    return {
      response: workbenchResultResponse({
        id: request.id,
        command: request.type,
        data: {
          selectedRunId: snapshot.selectedRunId,
          cursor: event.cursor,
          view: snapshot.view,
        },
      }),
      events: [event],
    };
  }

  private async command(
    request: WorkbenchCommandRequest,
  ): Promise<WorkbenchHandleResult> {
    const client = this.upsertClient({ clientId: request.clientId });
    switch (request.command.kind) {
      case "send-message":
        return await this.sendMessage(request, request.command, client);
      case "create-run":
        return await this.createRun(request, request.command, client);
      case "resume-run":
        return await this.resumeRun(request, request.command, client);
      case "stop-run":
        return await this.stopRun(request, request.command, client);
      case "open-run":
        client.selectedRunId = request.command.runId;
        return await this.commandViewResult(request, client, {
          reason: "open-run",
          data: {
            selectedRunId: client.selectedRunId,
          },
        });
      case "refresh":
        return await this.commandViewResult(request, client, {
          reason: "refresh",
          data: {},
        });
    }
  }

  private async sendMessage(
    request: WorkbenchCommandRequest,
    command: Extract<WorkbenchCommand, { kind: "send-message" }>,
    client: WorkbenchClientState,
  ): Promise<WorkbenchHandleResult> {
    if (!client.selectedRunId) {
      return {
        response: workbenchErrorResponse({
          id: request.id,
          code: "BAD_REQUEST",
          message: "Cannot send message without a selected run",
        }),
        events: [],
      };
    }
    const to = this.runEndpoint(client.selectedRunId);
    const posted = await this.backend.postUserMessage({
      runId: client.selectedRunId,
      from: this.userEndpoint,
      to,
      text: command.text,
      metadata: { source: "project-workbench" },
    });
    return await this.commandViewResult(request, client, {
      reason: "send-message",
      data: {
        selectedRunId: client.selectedRunId,
        posted,
      },
    });
  }

  private async createRun(
    request: WorkbenchCommandRequest,
    command: Extract<WorkbenchCommand, { kind: "create-run" }>,
    client: WorkbenchClientState,
  ): Promise<WorkbenchHandleResult> {
    const result = await this.backend.createRun({ task: command.task });
    client.selectedRunId = result.runId;
    return await this.commandViewResult(request, client, {
      reason: "create-run",
      data: result,
    });
  }

  private async resumeRun(
    request: WorkbenchCommandRequest,
    command: Extract<WorkbenchCommand, { kind: "resume-run" }>,
    client: WorkbenchClientState,
  ): Promise<WorkbenchHandleResult> {
    const result = await this.backend.startRun({ runId: command.runId });
    client.selectedRunId = result.runId;
    return await this.commandViewResult(request, client, {
      reason: "resume-run",
      data: result,
    });
  }

  private async stopRun(
    request: WorkbenchCommandRequest,
    command: Extract<WorkbenchCommand, { kind: "stop-run" }>,
    client: WorkbenchClientState,
  ): Promise<WorkbenchHandleResult> {
    const target = command.runId ?? client.selectedRunId ?? "latest";
    const result = await this.backend.stopRun({ runId: target });
    client.selectedRunId = result.runId;
    return await this.commandViewResult(request, client, {
      reason: "stop-run",
      data: result,
    });
  }

  private async commandViewResult(
    request: WorkbenchCommandRequest,
    client: WorkbenchClientState,
    input: {
      reason: WorkbenchViewUpdated["reason"];
      data: Record<string, unknown>;
    },
  ): Promise<WorkbenchHandleResult> {
    const event = requireWorkbenchEvent(
      await this.emitClientView(client, input.reason, {
        emitUnchanged: true,
      }),
    );
    return {
      response: workbenchResultResponse({
        id: request.id,
        command: request.type,
        data: {
          clientId: client.clientId,
          cursor: event.cursor,
          ...input.data,
        },
      }),
      events: [event],
    };
  }

  private async emitClientView(
    client: WorkbenchClientState,
    reason: WorkbenchViewUpdated["reason"],
    options: { emitUnchanged: boolean },
  ): Promise<WorkbenchEventMessage | undefined> {
    const snapshot = await this.backend.snapshot({
      selectedRunId: client.selectedRunId,
    });
    client.selectedRunId = snapshot.selectedRunId;
    const fingerprint = fingerprintView(snapshot);
    if (!options.emitUnchanged && client.lastViewFingerprint === fingerprint) {
      return undefined;
    }
    client.lastViewFingerprint = fingerprint;
    const event = this.appendViewEvent({
      kind: "view.updated",
      reason,
      selectedRunId: snapshot.selectedRunId,
      view: snapshot.view,
    });
    return event;
  }

  private appendViewEvent(event: WorkbenchViewUpdated): WorkbenchEventMessage {
    this.nextEventSeq += 1;
    const message: WorkbenchEventMessage = {
      schemaVersion: 1,
      id: this.newEventId(),
      type: "workbench.event",
      eventSeq: this.nextEventSeq,
      cursor: String(this.nextEventSeq),
      event,
    };
    this.eventLog.push(message);
    while (this.eventLog.length > this.maxEventLogSize) {
      this.eventLog.shift();
    }
    return message;
  }

  private eventsAfter(cursor: WorkbenchCursor | undefined): WorkbenchEventMessage[] {
    if (!cursor) {
      return [];
    }
    const seq = Number.parseInt(cursor, 10);
    if (!Number.isFinite(seq)) {
      throw new Error(`Invalid workbench cursor: ${cursor}`);
    }
    return this.eventLog.filter((event) => event.eventSeq > seq);
  }

  private currentCursor(): WorkbenchCursor {
    return String(this.nextEventSeq);
  }

  private upsertClient(input: {
    clientId?: string;
    selectedRunId?: string;
    port?: WorkbenchClientPort;
  }): WorkbenchClientState {
    const clientId = nonEmpty(input.clientId) ? input.clientId : this.newClientId();
    const existing = this.clients.get(clientId);
    const client: WorkbenchClientState =
      existing ??
      {
        clientId,
      };
    if (input.selectedRunId !== undefined) {
      client.selectedRunId = input.selectedRunId;
    }
    if (input.port) {
      client.port = input.port;
      input.port.onClose(() => {
        const current = this.clients.get(clientId);
        if (current?.port === input.port) {
          this.clients.delete(clientId);
        }
      });
    }
    this.clients.set(clientId, client);
    return client;
  }

  private requireClient(clientId: string): WorkbenchClientState {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Unknown workbench client: ${clientId}`);
    }
    return client;
  }
}

export function parseWorkbenchRequest(raw: string | Record<string, unknown>): WorkbenchRequest {
  const parsed = typeof raw === "string" ? parseJsonRecord(raw) : raw;
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid workbench request: schemaVersion must be 1");
  }
  if (!nonEmpty(parsed.id)) {
    throw new Error("Invalid workbench request: id must be non-empty string");
  }
  if (!nonEmpty(parsed.type)) {
    throw new Error("Invalid workbench request: type must be non-empty string");
  }
  switch (parsed.type) {
    case "workbench.connect":
      validateOptionalString(parsed, "clientId", parsed.type);
      validateOptionalString(parsed, "cursor", parsed.type);
      return parsed as WorkbenchConnectRequest;
    case "workbench.subscribe":
      validateOptionalString(parsed, "clientId", parsed.type);
      validateOptionalString(parsed, "selectedRunId", parsed.type);
      validateOptionalString(parsed, "cursor", parsed.type);
      return parsed as WorkbenchSubscribeRequest;
    case "workbench.replay":
      validateOptionalString(parsed, "cursor", parsed.type);
      return parsed as WorkbenchReplayRequest;
    case "workbench.snapshot":
      validateOptionalString(parsed, "selectedRunId", parsed.type);
      return parsed as WorkbenchSnapshotRequest;
    case "workbench.command":
      validateOptionalString(parsed, "clientId", parsed.type);
      if (!isRecord(parsed.command)) {
        throw new Error("Invalid workbench.command request: command must be object");
      }
      return {
        schemaVersion: 1,
        id: parsed.id,
        type: parsed.type,
        clientId: parsed.clientId as string | undefined,
        command: parseWorkbenchCommand(parsed.command),
      };
    default:
      throw new Error(`Unsupported workbench request: ${String(parsed.type)}`);
  }
}

export function parseWorkbenchServerMessage(
  raw: string,
  expectedId?: string,
): WorkbenchServerMessage {
  const parsed = parseJsonRecord(raw);
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid workbench response: schemaVersion must be 1");
  }
  if (!nonEmpty(parsed.id)) {
    throw new Error("Invalid workbench response: id must be non-empty string");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid workbench response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (parsed.type === "workbench.event") {
    if (typeof parsed.eventSeq !== "number" || !nonEmpty(parsed.cursor)) {
      throw new Error("Invalid workbench event: eventSeq and cursor are required");
    }
    return parsed as WorkbenchEventMessage;
  }
  if (parsed.type === "workbench.result" || parsed.type === "workbench.error") {
    if (typeof parsed.ok !== "boolean") {
      throw new Error("Invalid workbench response: ok is required");
    }
    return parsed as WorkbenchResponse;
  }
  throw new Error(`Invalid workbench response type: ${String(parsed.type)}`);
}

export function workbenchResultResponse(input: {
  id: string;
  command: WorkbenchRequest["type"];
  data: Record<string, unknown>;
}): WorkbenchResultResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: true,
    type: "workbench.result",
    command: input.command,
    data: input.data,
  };
}

export function workbenchErrorResponse(input: {
  id: string;
  code: WorkbenchErrorResponse["error"]["code"];
  message: string;
}): WorkbenchErrorResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: false,
    type: "workbench.error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function parseWorkbenchCommand(command: Record<string, unknown>): WorkbenchCommand {
  if (!nonEmpty(command.kind)) {
    throw new Error("Invalid workbench.command request: command.kind must be non-empty string");
  }
  switch (command.kind) {
    case "send-message":
      if (!nonEmpty(command.text)) {
        throw new Error("Invalid send-message command: text must be non-empty string");
      }
      return { kind: command.kind, text: command.text };
    case "create-run":
      validateOptionalString(command, "task", command.kind);
      return command.task === undefined
        ? { kind: command.kind }
        : { kind: command.kind, task: command.task as string };
    case "resume-run":
      if (!nonEmpty(command.runId)) {
        throw new Error("Invalid resume-run command: runId must be non-empty string");
      }
      return { kind: command.kind, runId: command.runId };
    case "stop-run":
      validateOptionalString(command, "runId", command.kind);
      return command.runId === undefined
        ? { kind: command.kind }
        : { kind: command.kind, runId: command.runId as string };
    case "open-run":
      if (!nonEmpty(command.runId)) {
        throw new Error("Invalid open-run command: runId must be non-empty string");
      }
      return { kind: command.kind, runId: command.runId };
    case "refresh":
      return { kind: command.kind };
    default:
      throw new Error(`Unsupported workbench command: ${String(command.kind)}`);
  }
}

function requireWorkbenchEvent(
  event: WorkbenchEventMessage | undefined,
): WorkbenchEventMessage {
  if (!event) {
    throw new Error("Expected workbench view event");
  }
  return event;
}

function fingerprintView(snapshot: ProjectSnapshotResult): string {
  return JSON.stringify({
    selectedRunId: snapshot.selectedRunId,
    view: snapshot.view,
  });
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid workbench JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid workbench JSON: expected object");
  }
  return parsed;
}

function validateOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throw new Error(`Invalid ${label} request: ${key} must be string`);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

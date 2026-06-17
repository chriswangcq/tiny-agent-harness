// ─── Project UI Controller ─────────────────────────────────────────
//
// Owns the project-level terminal UI. Runtime state, run projection, IM, and
// run lifecycle commands flow through a realtime workbench socket client.

import type {
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchViewUpdated,
} from "../runtime/project-workbench.js";
import { BlessedRenderer } from "./renderer.js";
import type { TuiKey, TuiViewModel } from "./types.js";
import {
  addControllerNotice,
  addPendingUserEcho,
  applyWorkbenchViewUpdate,
  buildControllerRenderView,
  createTuiControllerState,
  pendingUserEchoFromPost,
  setControllerSelectedRun,
  type TuiControllerState,
} from "./controller-state.js";
import { ViewModelBuilder } from "./view-model-builder.js";
import {
  createRuntimeWorkbenchClient,
  type TuiWorkbenchClientPort,
  type TuiWorkbenchSessionPort,
} from "./workbench-client.js";

export type TuiRendererPort = {
  render(view: TuiViewModel): void;
  onKey(handler: (key: TuiKey) => void): void;
  onMessage(handler: (text: string) => void): void;
  close(): void;
};

export type ProjectUiControllerOptions = {
  runtimeSocketPath: string;
  workbenchClient?: TuiWorkbenchClientPort;
  runtimeTimeoutMs?: number;
  newRequestId?: () => string;
  nowIso?: () => string;
  onStop?: () => Promise<void> | void;
  renderer?: TuiRendererPort;
  emptyViewFactory?: () => TuiViewModel;
};

export type ProjectUiCommand =
  | { kind: "create-run"; task?: string }
  | { kind: "open-run"; runId: string }
  | { kind: "resume-run"; runId: string }
  | { kind: "stop-run"; runId?: string }
  | { kind: "refresh" }
  | { kind: "help" };

export class ProjectUiController {
  private readonly renderer: TuiRendererPort;
  private readonly workbenchClient: TuiWorkbenchClientPort;
  private readonly newRequestId: () => string;
  private readonly nowIso: () => string;
  private readonly onStop?: () => Promise<void> | void;
  private readonly emptyViewFactory: () => TuiViewModel;
  private connectPromise: Promise<void> | undefined;
  private session: TuiWorkbenchSessionPort | undefined;
  private uiState: TuiControllerState = createTuiControllerState();

  constructor(options: ProjectUiControllerOptions) {
    this.renderer = options.renderer ?? new BlessedRenderer();
    this.newRequestId =
      options.newRequestId ??
      (() => `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.onStop = options.onStop;
    this.emptyViewFactory =
      options.emptyViewFactory ?? (() => new ViewModelBuilder().getViewModel());
    this.workbenchClient =
      options.workbenchClient ??
      createRuntimeWorkbenchClient({
        socketPath: options.runtimeSocketPath,
        timeoutMs: options.runtimeTimeoutMs ?? 30_000,
        newRequestId: this.newRequestId,
      });
    this.addSystemMessage(
      "Project UI ready. Use :new <task> to start a run, :open latest to inspect one, or :resume latest to restart it.",
    );
  }

  start(): void {
    void this.connect();

    this.renderer.onKey((key) => {
      if (key.name === "q") {
        void this.stop().finally(() => process.exit(0));
      }
    });

    this.renderer.onMessage(async (text: string) => {
      try {
        await this.handleInput(text);
      } catch (error) {
        this.addSystemMessage(`Input failed: ${errorMessage(error)}`);
        this.renderCurrentView();
      }
    });
  }

  async connect(): Promise<void> {
    if (this.session) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    this.connectPromise = this.workbenchClient
      .subscribe({
        selectedRunId: this.uiState.selectedRunId,
        onEvent: (event) => this.applyWorkbenchEvent(event),
        onError: (error) => {
          this.addSystemMessage(`Workbench socket error: ${error.message}`);
          this.renderCurrentView();
        },
      })
      .then((session) => {
        this.session = session;
      })
      .catch((error) => {
        this.addSystemMessage(`Workbench connection failed: ${errorMessage(error)}`);
        this.renderCurrentView();
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    await this.connectPromise;
  }

  async stop(): Promise<void> {
    this.session?.close();
    this.session = undefined;
    this.renderer.close();
    await this.onStop?.();
  }

  async handleInput(text: string): Promise<void> {
    const command = parseProjectUiCommand(text);
    if (!command) {
      await this.submitUserMessage(text);
      return;
    }
    await this.executeCommand(command);
  }

  async submitUserMessage(text: string): Promise<void> {
    const selectedRunId = this.uiState.selectedRunId;
    if (!selectedRunId) {
      this.addSystemMessage(
        "No active run. Use :new <task> to start one or :open latest to attach an existing run.",
      );
      this.renderCurrentView();
      return;
    }

    try {
      const data = await this.sendWorkbenchCommand({
        kind: "send-message",
        text,
      });
      this.uiState = addPendingUserEcho(
        this.uiState,
        pendingUserEchoFromPost({
          data,
          fallback: {
            id: this.newRequestId(),
            timestamp: this.nowIso(),
            runId: selectedRunId,
            text,
          },
        }),
      );
      this.renderCurrentView();
    } catch (error) {
      this.addSystemMessage(`Failed to send message: ${errorMessage(error)}`);
      this.renderCurrentView();
    }
  }

  private async executeCommand(command: ProjectUiCommand): Promise<void> {
    switch (command.kind) {
      case "create-run":
        await this.createRun(command.task);
        return;
      case "open-run":
        await this.openRun(command.runId);
        return;
      case "resume-run":
        await this.resumeRun(command.runId);
        return;
      case "stop-run":
        await this.stopRun(command.runId);
        return;
      case "refresh":
        await this.refresh();
        return;
      case "help":
        this.addSystemMessage(projectUiHelpText());
        this.renderCurrentView();
        return;
    }
  }

  private async createRun(task: string | undefined): Promise<void> {
    this.addSystemMessage(
      task ? `Starting new run with task: ${task}` : "Starting new run.",
    );
    this.renderCurrentView();
    try {
      const data = await this.sendWorkbenchCommand({
        kind: "create-run",
        ...(task ? { task } : {}),
      });
      const runId = requireString(data.runId, "create-run result runId");
      this.uiState = setControllerSelectedRun(this.uiState, runId);
      this.addSystemMessage(`Started run ${runId}.`);
      this.renderCurrentView();
    } catch (error) {
      this.addSystemMessage(`Failed to start run: ${errorMessage(error)}`);
      this.renderCurrentView();
    }
  }

  private async openRun(runId: string): Promise<void> {
    this.addSystemMessage(`Opening run ${runId}.`);
    this.renderCurrentView();
    try {
      const data = await this.sendWorkbenchCommand({ kind: "open-run", runId });
      if (typeof data.selectedRunId === "string") {
        this.uiState = setControllerSelectedRun(this.uiState, data.selectedRunId);
      }
    } catch (error) {
      this.addSystemMessage(`Failed to open run: ${errorMessage(error)}`);
      this.renderCurrentView();
    }
  }

  private async resumeRun(runIdOrLatest: string): Promise<void> {
    this.addSystemMessage(`Starting run ${runIdOrLatest}.`);
    this.renderCurrentView();
    try {
      const data = await this.sendWorkbenchCommand({
        kind: "resume-run",
        runId: runIdOrLatest,
      });
      const runId = requireString(data.runId, "resume-run result runId");
      this.uiState = setControllerSelectedRun(this.uiState, runId);
      this.addSystemMessage(
        data.alreadyRunning === true
          ? `Run ${runId} is already running.`
          : `Resumed run ${runId}.`,
      );
      this.renderCurrentView();
    } catch (error) {
      this.addSystemMessage(`Failed to resume run: ${errorMessage(error)}`);
      this.renderCurrentView();
    }
  }

  private async stopRun(runIdOrLatest: string | undefined): Promise<void> {
    const target = runIdOrLatest || this.uiState.selectedRunId || "latest";
    this.addSystemMessage(`Stopping run ${target}.`);
    this.renderCurrentView();
    try {
      const data = await this.sendWorkbenchCommand({
        kind: "stop-run",
        ...(runIdOrLatest ? { runId: runIdOrLatest } : {}),
      });
      const runId = requireString(data.runId, "stop-run result runId");
      this.addSystemMessage(
        data.stopped === true
          ? `Stop requested for run ${runId}.`
          : `Run ${runId} is not running.`,
      );
      this.renderCurrentView();
    } catch (error) {
      this.addSystemMessage(`Failed to stop run: ${errorMessage(error)}`);
      this.renderCurrentView();
    }
  }

  private async refresh(): Promise<void> {
    this.addSystemMessage("Run list refreshed.");
    this.renderCurrentView();
    try {
      await this.sendWorkbenchCommand({ kind: "refresh" });
    } catch (error) {
      this.addSystemMessage(`Failed to refresh: ${errorMessage(error)}`);
      this.renderCurrentView();
    }
  }

  private async sendWorkbenchCommand(
    command: WorkbenchCommand,
  ): Promise<Record<string, unknown>> {
    const session = await this.ensureWorkbenchSession();
    return await session.command(command);
  }

  private async ensureWorkbenchSession(): Promise<TuiWorkbenchSessionPort> {
    if (!this.session) {
      await this.connect();
    }
    if (!this.session) {
      throw new Error("Workbench session is not connected");
    }
    return this.session;
  }

  private applyWorkbenchEvent(event: WorkbenchEvent): void {
    if (event.kind === "view.updated") {
      this.applyViewUpdate(event);
    }
  }

  private applyViewUpdate(event: WorkbenchViewUpdated): void {
    this.uiState = applyWorkbenchViewUpdate(this.uiState, event);
    this.renderCurrentView();
  }

  private renderCurrentView(): void {
    this.renderer.render(
      buildControllerRenderView({
        state: this.uiState,
        emptyView: this.emptyViewFactory(),
      }),
    );
  }

  private addSystemMessage(text: string): void {
    this.uiState = addControllerNotice(this.uiState, {
      id: this.newRequestId(),
      timestamp: this.nowIso(),
      text,
    });
  }
}

export function parseProjectUiCommand(text: string): ProjectUiCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(":")) {
    return undefined;
  }

  const withoutPrefix = trimmed.slice(1).trim();
  if (withoutPrefix.length === 0) {
    return { kind: "help" };
  }

  const [name = "", ...restParts] = withoutPrefix.split(/\s+/u);
  const rest = restParts.join(" ").trim();
  switch (name.toLowerCase()) {
    case "new":
    case "n":
      return rest ? { kind: "create-run", task: rest } : { kind: "create-run" };
    case "open":
    case "switch":
    case "attach":
      return { kind: "open-run", runId: rest || "latest" };
    case "resume":
    case "start":
      return { kind: "resume-run", runId: rest || "latest" };
    case "stop":
    case "cancel":
      return rest ? { kind: "stop-run", runId: rest } : { kind: "stop-run" };
    case "refresh":
    case "reload":
      return { kind: "refresh" };
    case "help":
    case "?":
      return { kind: "help" };
    default:
      return undefined;
  }
}

function projectUiHelpText(): string {
  return [
    "Project UI commands:",
    ":new <task>      start a new run and attach it",
    ":new             start a run that waits for first message",
    ":open <runId>    attach an existing run without starting it",
    ":open latest     attach the latest run",
    ":resume <runId>  start an existing run process and attach it",
    ":stop [runId]    request SIGTERM for a running run",
    ":refresh         reload the run list",
  ].join("\n");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

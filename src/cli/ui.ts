import * as os from "node:os";
import * as path from "node:path";
import { ProjectUiController } from "../tui/controller.js";
import type { ProjectUiControllerOptions } from "../tui/controller.js";
import { StateRootResolver } from "../state/root.js";
import {
  JsonProcessRegistryStore,
  JsonlRuntimeEventSink,
  RunSupervisor,
  cleanupProjectUiEdgeRuntimeReplicas,
  defaultResidentSocketRoot,
  edgeRuntimeReplicaPaths,
  ensureEdgeRuntimeReplica,
  nodeProcessControl,
  nodeProcessSpawner,
} from "../runtime/index.js";

export type ProjectUiControllerOptionInput = {
  runtimeSocketPath: string;
  onStop?: () => Promise<void> | void;
};

export function buildProjectUiControllerOptions(
  input: ProjectUiControllerOptionInput,
): ProjectUiControllerOptions {
  return {
    runtimeSocketPath: input.runtimeSocketPath,
    ...(input.onStop ? { onStop: input.onStop } : {}),
  };
}

export type ProjectUiCliArgs = {
  stateDir?: string;
  help: boolean;
  unexpectedArgs: string[];
};

export function parseProjectUiCliArgs(args: readonly string[]): ProjectUiCliArgs {
  let stateDir: string | undefined;
  let help = false;
  const unexpectedArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "--help" || arg === "-h") && !help) {
      help = true;
    } else if (arg === "--state-dir" && i + 1 < args.length) {
      stateDir = args[++i];
    } else {
      unexpectedArgs.push(arg);
    }
  }

  return { stateDir, help, unexpectedArgs };
}

export async function runProjectUi(args: string[]): Promise<void> {
  const parsed = parseProjectUiCliArgs(args);
  if (parsed.help) {
    process.stdout.write(
      [
        "Usage:",
        "  tiny-agent ui [--state-dir <dir>]",
        "",
        "Inside the UI:",
        "  :new <task>      start a new run and attach it",
        "  :open <runId>    attach an existing run",
        "  :resume <runId>  start an existing run process",
      ].join("\n") + "\n",
    );
    return;
  }
  if (parsed.unexpectedArgs.length > 0) {
    console.error(
      `[tiny-agent] ERROR: tiny-agent ui received unexpected argument(s): ${formatUnexpectedArgs(parsed.unexpectedArgs)}`,
    );
    process.exit(1);
  }

  const stateRootInfo = new StateRootResolver().resolve({
    stateDir: parsed.stateDir,
  });
  const baseDir = stateRootInfo.stateDir;
  const residentSocketRoot = defaultResidentSocketRoot({ tmpDir: os.tmpdir() });
  const edgeId = `project-ui-${process.pid}`;
  const runtimePaths = edgeRuntimeReplicaPaths({
    stateDir: baseDir,
    edgeId,
    socketRoot: residentSocketRoot,
    socketScope: baseDir,
  });
  const processStore = new JsonProcessRegistryStore({
    filePath: path.join(baseDir, "processes.json"),
    nowIso: () => new Date().toISOString(),
  });
  const supervisor = new RunSupervisor({
    store: processStore,
    spawner: nodeProcessSpawner,
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
    events: new JsonlRuntimeEventSink({
      filePath: path.join(baseDir, "runtime", "events.jsonl"),
    }),
    newEventId: createRuntimeEventIdFactory("runtime-ui"),
    eventProducer: "tiny-agent-ui",
  });
  await cleanupProjectUiEdgeRuntimeReplicas({
    store: processStore,
    processControl: nodeProcessControl,
    projectId: stateRootInfo.projectConfig.projectId,
    currentEdgeId: edgeId,
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
  });
  const runtimeReplica = await ensureEdgeRuntimeReplica({
    paths: runtimePaths,
    edgeId,
    projectId: stateRootInfo.projectConfig.projectId,
    stateDir: baseDir,
    supervisor,
    executable: process.execPath,
    execArgv: process.execArgv,
    mainScript: process.argv[1]!,
    cwd: process.cwd(),
    env: process.env,
    startupTimeoutMs: 10_000,
  });

  const controller = new ProjectUiController(
    buildProjectUiControllerOptions({
      runtimeSocketPath: runtimeReplica.socketPath,
      onStop: runtimeReplica.dispose,
    }),
  );

  process.once("SIGINT", () => {
    void controller.stop().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void controller.stop().finally(() => process.exit(143));
  });
  controller.start();
}

function createRuntimeEventIdFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${Date.now()}-${++sequence}`;
}

function formatUnexpectedArgs(args: readonly string[]): string {
  return args.map((arg) => JSON.stringify(arg)).join(", ");
}

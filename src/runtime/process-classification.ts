import type { RuntimeProcessKind } from "./process-registry.js";

export type RuntimeResidency = "stateful-subprocess";

export type StatefulProcessClassification = {
  kind: RuntimeProcessKind;
  residency: RuntimeResidency;
  authority: string;
  liveResources: readonly string[];
  durableStateOwner: string;
  reason: string;
};

export type EdgerCliOperationKind =
  | "im-channel"
  | "team-roster"
  | "process-registry"
  | "mcp-registry"
  | "run-index"
  | "skill-store"
  | "project-config";

export type EdgerCliClassification = {
  operation: EdgerCliOperationKind;
  residency: "one-shot-edger-cli";
  durableStateOwner: string;
  reason: string;
};

const STATEFUL_PROCESS_CLASSIFICATIONS = {
  "runtime-replica": {
    kind: "runtime-replica",
    residency: "stateful-subprocess",
    authority: "RuntimeReplica",
    liveResources: [
      "run-local runtime socket request boundary",
      "project IM service request boundary",
      "active-active file-backed public runtime access",
    ],
    durableStateOwner: "runs/<runId>/runtime-replica.json, processes.json, and project-scoped stores",
    reason:
      "Each run owns its own runtime replica. Replicas share project durable truth through file locks, so public runtime access has no global resident leader.",
  },
  run: {
    kind: "run",
    residency: "stateful-subprocess",
    authority: "RunOrchestrator",
    liveResources: [
      "model turn stream",
      "tool call in-flight state",
      "environment polling timer",
      "child runtime ports",
    ],
    durableStateOwner: "runs/<runId>/",
    reason:
      "Agent execution has live model/tool/control flow that cannot be reconstructed from file snapshots alone.",
  },
  "terminal-host": {
    kind: "terminal-host",
    residency: "stateful-subprocess",
    authority: "TerminalHost",
    liveResources: [
      "PTY file descriptor",
      "child shell process",
      "screen buffer",
      "visual-line cursor window",
      "resident socket request boundary",
    ],
    durableStateOwner: "runs/<runId>/terminal-host.json",
    reason:
      "Terminal observations depend on live PTY state and stream ordering.",
  },
  "pty-session": {
    kind: "pty-session",
    residency: "stateful-subprocess",
    authority: "ManagedTerminalSession",
    liveResources: ["PTY file descriptor", "session child process"],
    durableStateOwner: "runs/<runId>/sessions/<sessionId>/",
    reason:
      "A PTY session is an active child process with live input/output streams.",
  },
  "codeq-host": {
    kind: "codeq-host",
    residency: "stateful-subprocess",
    authority: "CodeIntelHost",
    liveResources: ["LSP server process", "JSON-RPC session", "open document cache"],
    durableStateOwner: "runs/<runId>/codeq-host.json and process registry record",
    reason:
      "Run-scoped Code intelligence host keeps language-server state that must not be shared across runs.",
  },
  "skill-host": {
    kind: "skill-host",
    residency: "stateful-subprocess",
    authority: "SkillHost",
    liveResources: [
      "skill run command queue",
      "run-scoped skill execution environment",
      "environment event append boundary",
    ],
    durableStateOwner: "runs/<runId>/skill-host.json and skill-runs/",
    reason:
      "Skill operations mutate run-scoped skill state and emit environment events through the run-owned host boundary.",
  },
  "mcp-host": {
    kind: "mcp-host",
    residency: "stateful-subprocess",
    authority: "McpHost",
    liveResources: [
      "MCP client request queue",
      "MCP server transport/session lifecycle",
      "project MCP registry access boundary",
    ],
    durableStateOwner: "runs/<runId>/mcp-host.json and project mcp registry",
    reason:
      "MCP client operations connect to local or remote MCP servers through a run-owned host instead of one-shot public CLI clients.",
  },
  "model-gateway": {
    kind: "model-gateway",
    residency: "stateful-subprocess",
    authority: "ModelGatewayHost",
    liveResources: [
      "provider request stream",
      "cancellation boundary",
      "resident socket request boundary",
    ],
    durableStateOwner: "runs/<runId>/model-gateway.json",
    reason:
      "The run-owned gateway isolates provider streaming, cancellation, and request lifecycle behind the resident socket contract.",
  },
} as const satisfies Record<RuntimeProcessKind, StatefulProcessClassification>;

const EDGER_CLI_CLASSIFICATIONS = {
  "im-channel": {
    operation: "im-channel",
    residency: "one-shot-edger-cli",
    durableStateOwner: "im/",
    reason:
      "IM durable truth is project-scoped channel, pair, binding, and cursor files; live operational access is served by any run-owned runtime replica.",
  },
  "team-roster": {
    operation: "team-roster",
    residency: "one-shot-edger-cli",
    durableStateOwner: "teams/<teamId>/events.jsonl",
    reason:
      "Team commands mutate roster facts through durable event and snapshot files.",
  },
  "process-registry": {
    operation: "process-registry",
    residency: "one-shot-edger-cli",
    durableStateOwner: "processes.json",
    reason:
      "Registry commands read or update durable process records; they do not own the live child resources.",
  },
  "mcp-registry": {
    operation: "mcp-registry",
    residency: "one-shot-edger-cli",
    durableStateOwner: "mcp registry file",
    reason:
      "Registry edits are configuration facts; MCP client operations are served by the run-owned MCP host.",
  },
  "run-index": {
    operation: "run-index",
    residency: "one-shot-edger-cli",
    durableStateOwner: "runs/",
    reason:
      "Run listing, transcript reads, and exports derive from durable run files.",
  },
  "skill-store": {
    operation: "skill-store",
    residency: "one-shot-edger-cli",
    durableStateOwner: "skill-runs/",
    reason:
      "Skill durable files remain the storage owner; public skill operations are served by the run-owned skill host.",
  },
  "project-config": {
    operation: "project-config",
    residency: "one-shot-edger-cli",
    durableStateOwner: "project config files",
    reason:
      "Configuration commands read and write files; they should not become resident authorities.",
  },
} as const satisfies Record<EdgerCliOperationKind, EdgerCliClassification>;

export const STATEFUL_RUNTIME_PROCESS_KINDS = Object.freeze(
  Object.keys(STATEFUL_PROCESS_CLASSIFICATIONS) as RuntimeProcessKind[],
);

export const EDGER_CLI_OPERATION_KINDS = Object.freeze(
  Object.keys(EDGER_CLI_CLASSIFICATIONS) as EdgerCliOperationKind[],
);

export function isStatefulRuntimeProcessKind(
  kind: string,
): kind is RuntimeProcessKind {
  return kind in STATEFUL_PROCESS_CLASSIFICATIONS;
}

export function classifyRuntimeProcessKind(
  kind: RuntimeProcessKind,
): StatefulProcessClassification {
  return cloneStateful(STATEFUL_PROCESS_CLASSIFICATIONS[kind]);
}

export function classifyEdgerCliOperation(
  operation: EdgerCliOperationKind,
): EdgerCliClassification {
  return { ...EDGER_CLI_CLASSIFICATIONS[operation] };
}

function cloneStateful(
  classification: StatefulProcessClassification,
): StatefulProcessClassification {
  return {
    ...classification,
    liveResources: [...classification.liveResources],
  };
}

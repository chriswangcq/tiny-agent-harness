import type { ToolDefinition, JsonSchema } from "../types/index.js";

// ---------------------------------------------------------------------------
// Bash Tool Input JSON Schema (PTY action variants)
// ---------------------------------------------------------------------------

const SessionProperty = {
  type: "string",
  description: "Optional persistent PTY session id. Defaults to default when omitted.",
};

const ExpectedOwnerRevisionProperty = {
  type: "number",
  description:
    "TerminalOwner revision observed before choosing this action. Stale revisions are rejected.",
};

const BashToolInputSchema: JsonSchema = {
  type: "object",
  oneOf: [
    {
      title: "PtyWriteTextAction",
      required: ["kind", "expectedOwnerRevision", "text"],
      properties: {
        kind: { const: "write_text" },
        session: SessionProperty,
        expectedOwnerRevision: ExpectedOwnerRevisionProperty,
        text: {
          type: "string",
          description:
            "Text bytes to write to the current PTY owner. Include newline explicitly or use key enter.",
        },
      },
      additionalProperties: false,
    },
    {
      title: "PtyKeyAction",
      required: ["kind", "expectedOwnerRevision", "key"],
      properties: {
        kind: { const: "key" },
        session: SessionProperty,
        expectedOwnerRevision: ExpectedOwnerRevisionProperty,
        key: {
          enum: ["enter", "ctrl-c", "ctrl-d", "escape", "tab", "up", "down"],
        },
      },
      additionalProperties: false,
    },
    {
      title: "PtyInputFrameAction",
      required: ["kind", "expectedOwnerRevision", "receiverId", "seq", "dataBase64"],
      properties: {
        kind: { const: "input_frame" },
        session: SessionProperty,
        expectedOwnerRevision: ExpectedOwnerRevisionProperty,
        receiverId: { type: "string" },
        seq: { type: "number" },
        dataBase64: {
          type: "string",
          description:
            "One base64 frame for the active receiver. Do not put decoded payload bytes in the tool call.",
        },
      },
      additionalProperties: false,
    },
    {
      title: "PtyEndInputAction",
      required: ["kind", "expectedOwnerRevision", "receiverId", "frames", "bytes", "sha256"],
      properties: {
        kind: { const: "end_input" },
        session: SessionProperty,
        expectedOwnerRevision: ExpectedOwnerRevisionProperty,
        receiverId: { type: "string" },
        frames: { type: "number" },
        bytes: { type: "number" },
        sha256: { type: "string" },
      },
      additionalProperties: false,
    },
    {
      title: "PtyPollAction",
      required: ["kind"],
      properties: {
        kind: { const: "poll" },
        session: SessionProperty,
        sinceSeq: { type: "number" },
      },
      additionalProperties: false,
    },
    {
      title: "PtyStatusAction",
      required: ["kind"],
      properties: {
        kind: { const: "status" },
        session: SessionProperty,
      },
      additionalProperties: false,
    },
    {
      title: "PtyInterruptAction",
      required: ["kind"],
      properties: {
        kind: { const: "interrupt" },
        session: SessionProperty,
        expectedOwnerRevision: ExpectedOwnerRevisionProperty,
      },
      additionalProperties: false,
    },
    {
      title: "PtyTerminateAction",
      required: ["kind"],
      properties: {
        kind: { const: "terminate" },
        session: SessionProperty,
      },
      additionalProperties: false,
    },
    {
      title: "PtyRestartAction",
      required: ["kind"],
      properties: {
        kind: { const: "restart" },
        session: SessionProperty,
        cwd: { type: "string" },
      },
      additionalProperties: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tool Definition constant
// ---------------------------------------------------------------------------

export const BASH_TOOL_DEFINITION: ToolDefinition = {
  name: "bash",
  description:
    "Operate a persistent PTY session with owner/revision-guarded actions. " +
    "Use write_text to write exact text bytes, including explicit newlines when desired. " +
    "Use key for terminal keys. " +
    "Use receiver input_frame/end_input for large files, IM replies, generated code, or other multi-KB payloads. " +
    "Use poll/status/interrupt/terminate/restart to observe or recover terminal state.",
  inputSchema: BashToolInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [BASH_TOOL_DEFINITION] as const;

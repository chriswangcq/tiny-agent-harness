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
    "This is a pure PTY interface: write_text writes exact bytes to the current foreground terminal owner and never appends Enter for you; include \\n explicitly or use key enter. Large write_text payloads are allowed and internally paced. " +
    "Use key only for terminal keys such as enter, ctrl-c, ctrl-d, escape, tab, up, and down. " +
    "Use poll/status to observe and interrupt/terminate/restart to recover. After sending a multi-line heredoc or script, keep polling until the shell prompt returns; shell_continuation means the shell is still waiting for input. " +
    "For short IM replies, write an IM send command such as `node dist/cli/main.js im send --channel <channel> --kind status --text <reply>\\n`. " +
    "For generated text files or code, use shell heredocs or small scripts through write_text; the runtime paces large writes internally. " +
    "There is no model-visible file staging protocol, frame action, or binary payload channel. " +
    "Do not call non-PTY payload actions; the only bytes you can send are PTY bytes.",
  inputSchema: BashToolInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [BASH_TOOL_DEFINITION] as const;

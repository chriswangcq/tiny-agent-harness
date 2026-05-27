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
    "When owner.kind is process, write_text is accepted if stdinMode is interactive or unknown, and rejected only when stdinMode is none. Treat unknown as a foreground PTY process that may accept stdin; write only when you deliberately started it or it is clearly waiting for input. " +
    "For large generated text/code files, avoid shell parsing by starting a foreground stdin consumer such as `cat > path\\n`, polling until owner.kind is process, writing the file text directly, then sending ctrl-d and polling until the shell prompt returns. End text payloads with \\n; if not, ctrl-d may need to be sent twice. " +
    "For short IM replies, write an IM send command such as `node dist/cli/main.js im send --channel <channel> --kind status --text <reply>\\n`. " +
    "For small/simple generated text files or code, shell heredocs or small scripts through write_text are also fine; the runtime paces large writes internally. " +
    "There is no model-visible file staging protocol, frame action, or binary payload channel. " +
    "Do not call non-PTY payload actions; the only bytes you can send are PTY bytes.",
  inputSchema: BashToolInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [BASH_TOOL_DEFINITION] as const;

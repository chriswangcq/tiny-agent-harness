import type { ToolDefinition, JsonSchema } from "../types/index.js";

// ---------------------------------------------------------------------------
// Bash Tool Input JSON Schema (PTY action variants)
// ---------------------------------------------------------------------------

const SessionProperty = {
  type: "string",
  description: "Optional persistent PTY session id. Defaults to default when omitted.",
};

const ExpectedInputSeqProperty = {
  type: "number",
  description:
    "Terminal inputSeq observed before choosing this input action. Stale sequences are rejected.",
};

const BashToolInputSchema: JsonSchema = {
  type: "object",
  oneOf: [
    {
      title: "PtyWriteTextAction",
      required: ["kind", "expectedInputSeq", "text"],
      properties: {
        kind: { const: "write_text" },
        session: SessionProperty,
        expectedInputSeq: ExpectedInputSeqProperty,
        text: {
          type: "string",
          description:
            "Text bytes to write to the PTY. Include newline explicitly or use key enter.",
        },
      },
      additionalProperties: false,
    },
    {
      title: "PtyKeyAction",
      required: ["kind", "expectedInputSeq", "key"],
      properties: {
        kind: { const: "key" },
        session: SessionProperty,
        expectedInputSeq: ExpectedInputSeqProperty,
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
        expectedInputSeq: ExpectedInputSeqProperty,
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
    "Operate a persistent PTY session with inputSeq-guarded actions. " +
    "This is a pure PTY interface: write_text writes exact bytes to the terminal and never appends Enter for you; include \\n explicitly or use key enter. Large write_text payloads are allowed and internally paced, which solves PTY transport but not shell parsing. " +
    "After write_text/key input, the runtime waits briefly before reading output so immediate echo or command output can appear in the same observation. " +
    "Use key only for terminal keys such as enter, ctrl-c, ctrl-d, escape, tab, up, and down. " +
    "Use poll/status to observe and interrupt/terminate/restart to recover. The runtime reports terminal facts such as lastShellPrompt, lastContinuationPrompt, syncStatus, alive, and inputSeq; it does not infer whether shell, Python, ssh, cat, vim, or another foreground program should receive the next bytes. The agent must inspect the PTY output and terminal facts before deciding what to type. " +
    "Every write_text/key action must include the latest terminal.inputSeq from the prior observation. The sequence only prevents stale input; it is not a foreground process claim. " +
    "Do not put a large generated file in a shell heredoc or script string literal. For large generated text/code files, avoid shell parsing by starting a foreground stdin consumer such as `cat > path\\n`, polling until it is clearly waiting for input, writing the file text directly, then sending ctrl-d and polling until the shell prompt returns. End text payloads with \\n; if not, ctrl-d may need to be sent twice. " +
    "For short IM replies, write an IM send command such as `node dist/cli/main.js im send --channel <channel> --kind status --text <reply>\\n`. " +
    "For small/simple generated text files or code, shell heredocs or small scripts through write_text are also fine; the runtime paces large writes internally. " +
    "Large prior write_text payloads may be omitted from serialized prompt history to protect context; the actual executed tool call remains in the transcript, and PTY output remains available through bounded observations and logRef. " +
    "There is no model-visible file staging protocol, frame action, or binary payload channel. " +
    "Do not call non-PTY payload actions; the only bytes you can send are PTY bytes.",
  inputSchema: BashToolInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [BASH_TOOL_DEFINITION] as const;

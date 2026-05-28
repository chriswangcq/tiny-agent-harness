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
    "Use quoted shell heredocs only for small fixed snippets below about 4KB. For generated files, code, HTML, Markdown, JSON, or multiline IM replies above that size, call stash_file first, then use bash to run `node dist/cli/main.js file materialize <stashId> <target-path>`. " +
    "For interactive foreground stdin programs, use PTY input directly: start a foreground stdin consumer such as `cat > path\\n` or `node dist/cli/main.js im send --channel <channel> --kind status --text-stdin\\n`, poll until it is clearly waiting for input, write the payload text directly, send ctrl-d, and poll until the shell prompt returns. End text payloads with \\n before ctrl-d. If the payload does not end with \\n, one ctrl-d may only flush the current line while the foreground program keeps reading; do not send any further shell command until a prompt returns, and send a second ctrl-d if needed. " +
    "For short single-line IM replies with safe shell text, write an IM send command such as `node dist/cli/main.js im send --channel <channel> --kind status --text '<reply>'\\n`. For any reply containing newlines, quotes, backticks, pipes, or dollars, use stash_file plus `file materialize` for file output, or the foreground stdin consumer flow for interactive IM/stdin output. " +
    "The runtime paces large writes internally. " +
    "Large prior write_text or stash_file payloads may be omitted from serialized prompt history to protect context; the actual executed tool call remains in the transcript, and PTY output remains available through bounded observations and logRef. " +
    "Do not invent frame actions, side-channel payload protocols, or command-shaped bash payloads.",
  inputSchema: BashToolInputSchema,
};

const StashFileInputSchema: JsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    name: {
      type: "string",
      description:
        "Optional filename hint, for example snake.html. This does not write the target file.",
    },
    content: {
      type: "string",
      description:
        "Complete file content to stash in harness state. Use stash_file for generated files or multiline payloads that should not pass through shell parsing.",
    },
    encoding: {
      type: "string",
      enum: ["utf8", "base64"],
      description: "How to decode content into bytes. Defaults to utf8.",
    },
    description: {
      type: "string",
      description: "Optional short note describing the stashed file.",
    },
  },
  additionalProperties: false,
};

export const STASH_FILE_TOOL_DEFINITION: ToolDefinition = {
  name: "stash_file",
  description:
    "Stage complete file bytes in harness-managed state without writing the workspace. " +
    "Use this for generated files, HTML, Markdown, JSON, code, or any payload too large or fragile for a small quoted heredoc. " +
    "The tool returns stashId, bytes, sha256, and a materialize command. After it succeeds, use bash to run `node dist/cli/main.js file materialize <stashId> <target-path>` so the actual filesystem write happens through the PTY-visible CLI.",
  inputSchema: StashFileInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [
  BASH_TOOL_DEFINITION,
  STASH_FILE_TOOL_DEFINITION,
] as const;

import type { ToolDefinition, JsonSchema } from "../types/index.js";

// ---------------------------------------------------------------------------
// Bash Tool Input JSON Schema (oneOf with 5 variants)
// ---------------------------------------------------------------------------

const BashToolInputSchema: JsonSchema = {
  type: "object",
  oneOf: [
    {
      title: "BashCommandInput",
      required: ["command"],
      properties: {
        session: {
          type: "string",
          description:
            "Optional persistent bash session id. Defaults to default when omitted.",
        },
        command: {
          type: "string",
          description:
            "Bash command to execute in the selected session.",
        },
        timeoutMs: {
          type: "number",
          description:
            "How long the harness should focus-wait for completion. Defaults to 30000.",
        },
      },
      additionalProperties: false,
    },
    {
      title: "BashListControlInput",
      required: ["control"],
      properties: {
        control: {
          const: "list",
        },
      },
      additionalProperties: false,
    },
    {
      title: "BashCreateControlInput",
      required: ["control", "session"],
      properties: {
        control: {
          const: "create",
        },
        session: {
          type: "string",
        },
        cwd: {
          type: "string",
        },
        shell: {
          type: "string",
        },
        env: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
        },
        defaultTimeoutMs: {
          type: "number",
        },
        maxObservationBytes: {
          type: "number",
        },
      },
      additionalProperties: false,
    },
    {
      title: "BashSessionControlInput",
      required: ["control", "session"],
      properties: {
        control: {
          enum: ["status", "poll", "interrupt", "terminate", "restart"],
        },
        session: {
          type: "string",
        },
      },
      additionalProperties: false,
    },
    {
      title: "BashSendInputControlInput",
      required: ["control", "session", "input"],
      properties: {
        control: {
          const: "sendInput",
        },
        session: {
          type: "string",
        },
        input: {
          type: "string",
        },
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
    "Run shell commands or manage persistent bash sessions. All external actions must go through this tool, " +
    "including materializing staged artifacts with `node dist/cli/main.js artifact write <artifactId> <path>`. " +
    "Do not embed generated files, long heredocs, large node -e strings, or other multi-KB payloads in bash; " +
    "stage those bytes with stash_file first, then run a short bash command.",
  inputSchema: BashToolInputSchema,
};

const StashFileInputSchema: JsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    name: {
      type: "string",
      description:
        "Optional human-readable filename hint, for example snake.html.",
    },
    content: {
      type: "string",
      description:
        "File content to stage in harness state. Use this instead of putting large content in bash. Use base64 when encoding is base64.",
    },
    encoding: {
      type: "string",
      enum: ["utf8", "base64"],
      description:
        "How to decode content into bytes. Defaults to utf8 when omitted.",
    },
    description: {
      type: "string",
      description: "Optional short note describing the staged file.",
    },
  },
  additionalProperties: false,
};

export const STASH_FILE_TOOL_DEFINITION: ToolDefinition = {
  name: "stash_file",
  description:
    "Stage generated file bytes in harness-managed artifact state without writing to the target filesystem. " +
    "Use this for complete generated files, multi-line content, or payloads over about 2KB; do not send those bytes through bash. " +
    "After this returns an artifact id, use bash to run `node dist/cli/main.js artifact write <artifactId> <path>`.",
  inputSchema: StashFileInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [
  BASH_TOOL_DEFINITION,
  STASH_FILE_TOOL_DEFINITION,
] as const;

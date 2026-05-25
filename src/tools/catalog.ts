import type { ToolDefinition, JsonSchema } from "../types/index.js";

// ---------------------------------------------------------------------------
// Bash Tool Input JSON Schema (oneOf with 5 variants)
// ---------------------------------------------------------------------------

const BashToolInputSchema: JsonSchema = {
  type: "object",
  oneOf: [
    {
      title: "BashCommandInput",
      required: ["session", "command"],
      properties: {
        session: {
          type: "string",
          description:
            "Persistent bash session id, such as default, server, test, or scratch.",
        },
        command: {
          type: "string",
          description:
            "Bash command to execute in the specified session.",
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
    "Run bash commands or manage persistent bash sessions. All external actions must go through this tool.",
  inputSchema: BashToolInputSchema,
};

// ---------------------------------------------------------------------------
// Static Tool Catalog
// ---------------------------------------------------------------------------

export const STATIC_TOOL_CATALOG = [BASH_TOOL_DEFINITION] as const;

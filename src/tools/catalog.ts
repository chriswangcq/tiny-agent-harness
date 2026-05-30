import type { JsonSchema, ToolDefinition } from "../types/index.js";

const ExpectedInputSeqProperty: JsonSchema = {
  type: "integer",
  minimum: 0,
  description:
    "The current terminal.inputSeq observed before choosing this input action.",
};

const WaitForReturnMsProperty: JsonSchema = {
  type: "integer",
  minimum: 0,
  description:
    "Optional maximum time to stay focused waiting for the terminal to return to a prompt.",
};

const SessionProperty: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Persistent PTY session id.",
};

const ReasonProperty: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Short reason for the session control operation.",
};

const CwdProperty: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Working directory for a newly created or restarted session.",
};

const terminalWriteSchema: JsonSchema = {
  type: "object",
  required: ["expectedInputSeq", "text"],
  properties: {
    expectedInputSeq: ExpectedInputSeqProperty,
    text: {
      type: "string",
      description:
        "Exact bytes to write to the current terminal session. It does not append Enter.",
    },
    waitForReturnMs: WaitForReturnMsProperty,
  },
  additionalProperties: false,
};

const terminalKeySchema: JsonSchema = {
  type: "object",
  required: ["expectedInputSeq", "key"],
  properties: {
    expectedInputSeq: ExpectedInputSeqProperty,
    key: {
      enum: ["enter", "ctrl-d", "escape", "tab", "up", "down", "left", "right"],
      description:
        "A terminal key sent to the current session. Use session_interrupt for Ctrl-C.",
    },
    waitForReturnMs: WaitForReturnMsProperty,
  },
  additionalProperties: false,
};

const sessionObserveSchema: JsonSchema = {
  type: "object",
  properties: {
    session: {
      ...SessionProperty,
      description:
        "Optional PTY session id to observe without changing the current session.",
    },
  },
  additionalProperties: false,
};

const sessionListSchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const sessionFocusSchema: JsonSchema = {
  type: "object",
  required: ["session"],
  properties: {
    session: SessionProperty,
    create: {
      type: "boolean",
      description: "Create the session if it does not exist.",
    },
    cwd: CwdProperty,
  },
  additionalProperties: false,
};

const sessionInterruptSchema: JsonSchema = {
  type: "object",
  required: ["expectedInputSeq"],
  properties: {
    expectedInputSeq: ExpectedInputSeqProperty,
    waitForReturnMs: WaitForReturnMsProperty,
  },
  additionalProperties: false,
};

const sessionRestartSchema: JsonSchema = {
  type: "object",
  properties: {
    session: {
      ...SessionProperty,
      description:
        "Optional PTY session id. Defaults to the current session when omitted.",
    },
    cwd: CwdProperty,
    reason: ReasonProperty,
  },
  additionalProperties: false,
};

const sessionTerminateSchema: JsonSchema = {
  type: "object",
  properties: {
    session: {
      ...SessionProperty,
      description:
        "Optional PTY session id. Defaults to the current session when omitted.",
    },
    reason: ReasonProperty,
  },
  additionalProperties: false,
};

export const TERMINAL_WRITE_TOOL_DEFINITION: ToolDefinition = {
  name: "terminal_write",
  description:
    "Write exact text to the current PTY session. This never appends Enter; include a newline or use terminal_key with enter. The observation returns one terminal screen and the latest terminal.inputSeq.",
  inputSchema: terminalWriteSchema,
};

export const TERMINAL_KEY_TOOL_DEFINITION: ToolDefinition = {
  name: "terminal_key",
  description:
    "Send a non-interrupt terminal key to the current PTY session. Use session_interrupt for Ctrl-C. The observation returns one terminal screen and the latest terminal.inputSeq.",
  inputSchema: terminalKeySchema,
};

export const SESSION_OBSERVE_TOOL_DEFINITION: ToolDefinition = {
  name: "session_observe",
  description:
    "Observe a PTY session without sending input. Omit session to observe the current session. The observation is one terminal screen plus terminal facts.",
  inputSchema: sessionObserveSchema,
};

export const SESSION_LIST_TOOL_DEFINITION: ToolDefinition = {
  name: "session_list",
  description:
    "List known PTY sessions and identify the current session.",
  inputSchema: sessionListSchema,
};

export const SESSION_FOCUS_TOOL_DEFINITION: ToolDefinition = {
  name: "session_focus",
  description:
    "Set the current PTY session. Optionally create it with an explicit cwd.",
  inputSchema: sessionFocusSchema,
};

export const SESSION_INTERRUPT_TOOL_DEFINITION: ToolDefinition = {
  name: "session_interrupt",
  description:
    "Send Ctrl-C to the current PTY session using the latest expectedInputSeq guard.",
  inputSchema: sessionInterruptSchema,
};

export const SESSION_RESTART_TOOL_DEFINITION: ToolDefinition = {
  name: "session_restart",
  description:
    "Restart a PTY session. Omit session to restart the current session.",
  inputSchema: sessionRestartSchema,
};

export const SESSION_TERMINATE_TOOL_DEFINITION: ToolDefinition = {
  name: "session_terminate",
  description:
    "Terminate a PTY session. Omit session to terminate the current session.",
  inputSchema: sessionTerminateSchema,
};

export const STATIC_TOOL_CATALOG = [
  TERMINAL_WRITE_TOOL_DEFINITION,
  TERMINAL_KEY_TOOL_DEFINITION,
  SESSION_OBSERVE_TOOL_DEFINITION,
  SESSION_LIST_TOOL_DEFINITION,
  SESSION_FOCUS_TOOL_DEFINITION,
  SESSION_INTERRUPT_TOOL_DEFINITION,
  SESSION_RESTART_TOOL_DEFINITION,
  SESSION_TERMINATE_TOOL_DEFINITION,
] as const;

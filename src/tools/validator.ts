import type {
  InternalToolCall,
  ToolCallValidation,
  ToolRequest,
  AgentObservation,
  BashCommandInput,
  BashControlInput,
  StashFileInput,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalid(message: string): ToolCallValidation {
  const observation: AgentObservation = {
    kind: "tool_validation",
    message,
    recoverable: true,
  };
  return { status: "invalid", observation };
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ---------------------------------------------------------------------------
// ToolCallValidator
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

const SESSION_CONTROLS = new Set([
  "status",
  "poll",
  "interrupt",
  "terminate",
  "restart",
]);

export class ToolCallValidator {
  validate(toolCall: InternalToolCall): ToolCallValidation {
    const toolName = (toolCall as { name: string }).name;

    if (toolName === "stash_file") {
      return this.validateStashFile(
        toolCall.id,
        toolCall.arguments as StashFileInput,
      );
    }

    if (toolName !== "bash") {
      return invalid(
        `Unknown tool "${toolName}". Available tools are "bash" and "stash_file".`,
      );
    }

    const args = toolCall.arguments;

    // Discriminate: control input vs command input
    if ("control" in args && args.control !== undefined) {
      return this.validateControl(toolCall.id, args as BashControlInput);
    }

    // Must be a command input
    return this.validateCommand(toolCall.id, args as BashCommandInput);
  }

  private validateStashFile(
    toolCallId: string,
    args: StashFileInput,
  ): ToolCallValidation {
    if (!isString(args.content)) {
      return invalid(
        "Invalid stash_file arguments: content must be a string.",
      );
    }

    if (args.name !== undefined && !isString(args.name)) {
      return invalid("Invalid stash_file arguments: name must be a string.");
    }

    if (args.description !== undefined && !isString(args.description)) {
      return invalid(
        "Invalid stash_file arguments: description must be a string.",
      );
    }

    const encoding = args.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      return invalid(
        'Invalid stash_file arguments: encoding must be "utf8" or "base64".',
      );
    }

    const request: ToolRequest = {
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId,
      name: args.name,
      content: args.content,
      encoding,
      description: args.description,
    };

    return { status: "valid", request };
  }

  // -----------------------------------------------------------------------
  // Command validation
  // -----------------------------------------------------------------------

  private validateCommand(
    toolCallId: string,
    args: BashCommandInput,
  ): ToolCallValidation {
    if (!isNonEmptyString(args.command)) {
      return invalid(
        "Invalid bash tool arguments: command input requires a non-empty command.",
      );
    }

    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const session = isNonEmptyString(args.session) ? args.session : "default";

    const request: ToolRequest = {
      kind: "command",
      toolName: "bash",
      toolCallId,
      session,
      command: args.command,
      timeoutMs,
    };

    return { status: "valid", request };
  }

  // -----------------------------------------------------------------------
  // Control validation
  // -----------------------------------------------------------------------

  private validateControl(
    toolCallId: string,
    args: BashControlInput,
  ): ToolCallValidation {
    const control = args.control;

    // list — no session required
    if (control === "list") {
      const request: ToolRequest = {
        kind: "control",
        toolName: "bash",
        toolCallId,
        control: "list",
      };
      return { status: "valid", request };
    }

    // create — requires session
    if (control === "create") {
      if (!isNonEmptyString(args.session)) {
        return invalid(
          "Invalid bash tool arguments: create control requires a non-empty session.",
        );
      }
      const request: ToolRequest = {
        kind: "control",
        toolName: "bash",
        toolCallId,
        session: args.session,
        control: "create",
        createOptions: {
          cwd: isString(args.cwd) ? args.cwd : undefined,
          shell: isString(args.shell) ? args.shell : undefined,
          env: args.env,
          defaultTimeoutMs:
            typeof args.defaultTimeoutMs === "number"
              ? args.defaultTimeoutMs
              : undefined,
          maxObservationBytes:
            typeof args.maxObservationBytes === "number"
              ? args.maxObservationBytes
              : undefined,
        },
      };
      return { status: "valid", request };
    }

    // sendInput — requires session + input
    if (control === "sendInput") {
      if (!isNonEmptyString(args.session)) {
        return invalid(
          "Invalid bash tool arguments: sendInput control requires a non-empty session.",
        );
      }
      if (!isString(args.input)) {
        return invalid(
          "Invalid bash tool arguments: sendInput control requires an input string.",
        );
      }
      const request: ToolRequest = {
        kind: "control",
        toolName: "bash",
        toolCallId,
        session: args.session,
        control: "sendInput",
        input: args.input,
      };
      return { status: "valid", request };
    }

    // status | poll | interrupt | terminate | restart — requires session
    if (SESSION_CONTROLS.has(control)) {
      if (!isNonEmptyString(args.session)) {
        return invalid(
          `Invalid bash tool arguments: ${control} control requires a non-empty session.`,
        );
      }
      const request: ToolRequest = {
        kind: "control",
        toolName: "bash",
        toolCallId,
        session: args.session,
        control: control as
          | "status"
          | "poll"
          | "interrupt"
          | "terminate"
          | "restart",
      };
      return { status: "valid", request };
    }

    return invalid(
      `Invalid bash tool arguments: unknown control "${String(control)}".`,
    );
  }
}

import type {
  InternalToolCall,
  ToolCallValidation,
  ToolRequest,
  AgentObservation,
} from "../types/index.js";
import type { PtyAction, TerminalState } from "../terminal/types.js";
import {
  validatePtyAction,
  type PtyActionLimits,
} from "../terminal/validator.js";

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

export type ToolCallValidatorOptions = {
  terminal?: TerminalState;
  actionLimits?: Partial<PtyActionLimits>;
};

export class ToolCallValidator {
  constructor(private readonly options: ToolCallValidatorOptions = {}) {}

  validate(toolCall: InternalToolCall): ToolCallValidation {
    const toolName = (toolCall as { name: string }).name;

    if (toolName !== "bash") {
      return invalid(`Unknown tool "${toolName}". Available tool is "bash".`);
    }

    const args = toolCall.arguments;

    if ("kind" in args && args.kind !== undefined) {
      return this.validatePtyAction(toolCall.id, args as Record<string, unknown>);
    }

    if ("command" in args || "control" in args) {
      return invalid(
        "Invalid bash tool arguments: payload must be a PTY action object. " +
          "Use PTY actions such as write_text, key, poll, status, interrupt, terminate, or restart.",
      );
    }

    return invalid("Invalid bash tool arguments: expected a PTY action `kind`.");
  }

  private validatePtyAction(
    toolCallId: string,
    args: Record<string, unknown>,
  ): ToolCallValidation {
    const action = parsePtyAction(args);
    if (typeof action === "string") {
      return invalid(action);
    }

    if (this.options.terminal !== undefined) {
      const validation = validatePtyAction({
        action,
        terminal: this.options.terminal,
        limits: this.options.actionLimits,
      });
      if (!validation.ok) {
        return invalid(`${validation.code}: ${validation.message}`);
      }
    }

    const request: ToolRequest = {
      kind: "pty_action",
      toolName: "bash",
      toolCallId,
      action,
    };

    return { status: "valid", request };
  }
}

function parsePtyAction(args: Record<string, unknown>): PtyAction | string {
  if (!isString(args.kind)) {
    return "Invalid bash tool arguments: PTY action kind must be a string.";
  }

  const session = parseOptionalSession(args.session);
  if (typeof session === "string" && session.startsWith("error:")) {
    return session.slice("error:".length);
  }

  switch (args.kind) {
    case "write_text": {
      const common = parseExpectedInputSeq(args);
      if (typeof common === "string") return common;
      if (!isString(args.text)) {
        return "Invalid bash tool arguments: write_text requires text.";
      }
      return { kind: "write_text", session, ...common, text: args.text };
    }
    case "key": {
      const common = parseExpectedInputSeq(args);
      if (typeof common === "string") return common;
      if (!isTerminalKey(args.key)) {
        return "Invalid bash tool arguments: key requires a supported terminal key.";
      }
      return { kind: "key", session, ...common, key: args.key };
    }
    case "poll": {
      const sinceSeq =
        args.sinceSeq === undefined
          ? undefined
          : parseNonNegativeInteger(args.sinceSeq, "sinceSeq");
      if (typeof sinceSeq === "string") return sinceSeq;
      return { kind: "poll", session, sinceSeq };
    }
    case "status":
      return { kind: "status", session };
    case "interrupt": {
      if (args.expectedInputSeq !== undefined) {
        const common = parseExpectedInputSeq(args);
        if (typeof common === "string") return common;
        return { kind: "interrupt", session, ...common };
      }
      return { kind: "interrupt", session };
    }
    case "terminate":
      return { kind: "terminate", session };
    case "restart": {
      if (args.cwd !== undefined && !isString(args.cwd)) {
        return "Invalid bash tool arguments: restart cwd must be a string.";
      }
      return { kind: "restart", session, cwd: args.cwd };
    }
    default:
      return `Invalid bash tool arguments: unknown PTY action kind "${args.kind}".`;
  }
}

function parseExpectedInputSeq(
  args: Record<string, unknown>,
): { expectedInputSeq: number } | string {
  const value = args.expectedInputSeq;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return "Invalid bash tool arguments: expectedInputSeq must be a non-negative integer.";
  }
  return { expectedInputSeq: value };
}

function parseOptionalSession(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonEmptyString(value)) {
    return "error:Invalid bash tool arguments: session must be a non-empty string when provided.";
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, name: string): number | string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return `Invalid bash tool arguments: ${name} must be a non-negative integer.`;
  }
  return value;
}

function isTerminalKey(value: unknown): value is Extract<PtyAction, { kind: "key" }>["key"] {
  return (
    value === "enter" ||
    value === "ctrl-c" ||
    value === "ctrl-d" ||
    value === "escape" ||
    value === "tab" ||
    value === "up" ||
    value === "down"
  );
}

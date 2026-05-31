import type {
  AgentObservation,
  InternalToolCall,
  ToolCallValidation,
  ToolName,
} from "../types/index.js";
import { MODEL_VISIBLE_TOOL_NAMES } from "../types/tools.js";
import type {
  TerminalKey,
  TerminalState,
  TerminalToolRequest,
} from "../terminal/types.js";
import { TERMINAL_KEYS } from "../terminal/types.js";

function invalid(message: string): ToolCallValidation {
  const observation: AgentObservation = {
    kind: "tool_validation",
    message,
    recoverable: true,
  };
  return { status: "invalid", observation };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export type ToolCallValidatorOptions = {
  terminal?: TerminalState;
};

export class ToolCallValidator {
  constructor(private readonly options: ToolCallValidatorOptions = {}) {}

  validate(toolCall: InternalToolCall): ToolCallValidation {
    const toolName = (toolCall as { name: string }).name;
    const args = toolCall.arguments;

    if (!isRecord(args)) {
      return invalid(
        `Invalid ${toolName} tool arguments: expected an object payload.`,
      );
    }

    if (!isToolName(toolName)) {
      return invalid(
        `Unknown tool "${toolName}". Available tools are ${formatToolNames()}.`,
      );
    }

    const request = this.parseRequest(toolName, args);
    if (typeof request === "string") {
      return invalid(request);
    }

    return {
      status: "valid",
      request: {
        kind: "terminal_tool",
        toolName,
        toolCallId: toolCall.id,
        request,
      },
    };
  }

  private parseRequest(
    toolName: ToolName,
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    switch (toolName) {
      case "terminal_write":
        return this.parseTerminalWrite(args);
      case "terminal_key":
        return this.parseTerminalKey(args);
      case "session_observe":
        return this.parseSessionObserve(args);
      case "session_list":
        return this.parseSessionList(args);
      case "session_focus":
        return this.parseSessionFocus(args);
      case "session_interrupt":
        return this.parseSessionInterrupt(args);
      case "session_restart":
        return this.parseSessionRestart(args);
      case "session_terminate":
        return this.parseSessionTerminate(args);
    }
  }

  private parseTerminalWrite(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, [
      "expectedInputSeq",
      "text",
      "waitForReturnMs",
    ]);
    if (unexpected) return invalidArg("terminal_write", unexpected);

    const expectedInputSeq = parseExpectedInputSeq("terminal_write", args);
    if (typeof expectedInputSeq === "string") return expectedInputSeq;
    const seqValidation = this.validateExpectedInputSeq(
      "terminal_write",
      expectedInputSeq,
    );
    if (seqValidation) return seqValidation;

    if (!isString(args.text)) {
      return "Invalid terminal_write arguments: text must be a string.";
    }
    const payloadValidation = validateTerminalWriteText(args.text);
    if (payloadValidation) return payloadValidation;

    const waitForReturnMs = parseOptionalNonNegativeInteger(
      "terminal_write",
      "waitForReturnMs",
      args.waitForReturnMs,
    );
    if (typeof waitForReturnMs === "string") return waitForReturnMs;

    return {
      kind: "terminal_write",
      expectedInputSeq,
      text: args.text,
      ...(waitForReturnMs === undefined ? {} : { waitForReturnMs }),
    };
  }

  private parseTerminalKey(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, [
      "expectedInputSeq",
      "key",
      "waitForReturnMs",
    ]);
    if (unexpected) return invalidArg("terminal_key", unexpected);

    const expectedInputSeq = parseExpectedInputSeq("terminal_key", args);
    if (typeof expectedInputSeq === "string") return expectedInputSeq;
    const seqValidation = this.validateExpectedInputSeq(
      "terminal_key",
      expectedInputSeq,
    );
    if (seqValidation) return seqValidation;

    if (!isTerminalKey(args.key)) {
      return `Invalid terminal_key arguments: key must be one of ${TERMINAL_KEYS.join(", ")}. Use session_interrupt for Ctrl-C.`;
    }

    const waitForReturnMs = parseOptionalNonNegativeInteger(
      "terminal_key",
      "waitForReturnMs",
      args.waitForReturnMs,
    );
    if (typeof waitForReturnMs === "string") return waitForReturnMs;

    return {
      kind: "terminal_key",
      expectedInputSeq,
      key: args.key,
      ...(waitForReturnMs === undefined ? {} : { waitForReturnMs }),
    };
  }

  private parseSessionObserve(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, ["session"]);
    if (unexpected) return invalidArg("session_observe", unexpected);

    const session = parseOptionalSession("session_observe", args.session);
    if (typeof session === "string" && session.startsWith("error:")) {
      return session.slice("error:".length);
    }

    return { kind: "session_observe", ...(session ? { session } : {}) };
  }

  private parseSessionList(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, []);
    if (unexpected) return invalidArg("session_list", unexpected);
    return { kind: "session_list" };
  }

  private parseSessionFocus(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, ["session", "create", "cwd"]);
    if (unexpected) return invalidArg("session_focus", unexpected);

    if (!isNonEmptyString(args.session)) {
      return "Invalid session_focus arguments: session must be a non-empty string.";
    }
    if (args.create !== undefined && typeof args.create !== "boolean") {
      return "Invalid session_focus arguments: create must be a boolean when provided.";
    }
    if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
      return "Invalid session_focus arguments: cwd must be a non-empty string when provided.";
    }

    return {
      kind: "session_focus",
      session: args.session,
      ...(args.create === undefined ? {} : { create: args.create }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    };
  }

  private parseSessionInterrupt(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, [
      "expectedInputSeq",
      "waitForReturnMs",
    ]);
    if (unexpected) return invalidArg("session_interrupt", unexpected);

    const expectedInputSeq = parseExpectedInputSeq("session_interrupt", args);
    if (typeof expectedInputSeq === "string") return expectedInputSeq;
    const seqValidation = this.validateExpectedInputSeq(
      "session_interrupt",
      expectedInputSeq,
    );
    if (seqValidation) return seqValidation;

    const waitForReturnMs = parseOptionalNonNegativeInteger(
      "session_interrupt",
      "waitForReturnMs",
      args.waitForReturnMs,
    );
    if (typeof waitForReturnMs === "string") return waitForReturnMs;

    return {
      kind: "session_interrupt",
      expectedInputSeq,
      ...(waitForReturnMs === undefined ? {} : { waitForReturnMs }),
    };
  }

  private parseSessionRestart(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, ["session", "cwd", "reason"]);
    if (unexpected) return invalidArg("session_restart", unexpected);

    const session = parseOptionalSession("session_restart", args.session);
    if (typeof session === "string" && session.startsWith("error:")) {
      return session.slice("error:".length);
    }
    const cwd = parseOptionalNonEmptyString("session_restart", "cwd", args.cwd);
    if (typeof cwd === "string" && cwd.startsWith("error:")) {
      return cwd.slice("error:".length);
    }
    const reason = parseOptionalNonEmptyString(
      "session_restart",
      "reason",
      args.reason,
    );
    if (typeof reason === "string" && reason.startsWith("error:")) {
      return reason.slice("error:".length);
    }

    return {
      kind: "session_restart",
      ...(session ? { session } : {}),
      ...(cwd ? { cwd } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private parseSessionTerminate(
    args: Record<string, unknown>,
  ): TerminalToolRequest | string {
    const unexpected = rejectUnexpectedArgs(args, ["session", "reason"]);
    if (unexpected) return invalidArg("session_terminate", unexpected);

    const session = parseOptionalSession("session_terminate", args.session);
    if (typeof session === "string" && session.startsWith("error:")) {
      return session.slice("error:".length);
    }
    const reason = parseOptionalNonEmptyString(
      "session_terminate",
      "reason",
      args.reason,
    );
    if (typeof reason === "string" && reason.startsWith("error:")) {
      return reason.slice("error:".length);
    }

    return {
      kind: "session_terminate",
      ...(session ? { session } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private validateExpectedInputSeq(
    toolName: ToolName,
    expectedInputSeq: number,
  ): string | undefined {
    const terminal = this.options.terminal;
    if (terminal === undefined || terminal.inputSeq === expectedInputSeq) {
      return undefined;
    }
    return (
      `INPUT_SEQ_MISMATCH: Invalid ${toolName} arguments: expectedInputSeq ` +
      `${expectedInputSeq} does not match terminal.inputSeq ${terminal.inputSeq}.`
    );
  }
}

function rejectUnexpectedArgs(
  args: Record<string, unknown>,
  allowed: string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(args).find((key) => !allowedSet.has(key));
}

function invalidArg(toolName: ToolName, argName: string): string {
  return `Invalid ${toolName} arguments: unexpected argument "${argName}".`;
}

function parseExpectedInputSeq(
  toolName: ToolName,
  args: Record<string, unknown>,
): number | string {
  const value = args.expectedInputSeq;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return `Invalid ${toolName} arguments: expectedInputSeq must be a non-negative integer.`;
  }
  return value;
}

function parseOptionalSession(
  toolName: ToolName,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    return `error:Invalid ${toolName} arguments: session must be a non-empty string when provided.`;
  }
  return value;
}

function parseOptionalNonEmptyString(
  toolName: ToolName,
  argName: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    return `error:Invalid ${toolName} arguments: ${argName} must be a non-empty string when provided.`;
  }
  return value;
}

function parseOptionalNonNegativeInteger(
  toolName: ToolName,
  argName: string,
  value: unknown,
): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return `Invalid ${toolName} arguments: ${argName} must be a non-negative integer when provided.`;
  }
  return value;
}

function validateTerminalWriteText(text: string): string | undefined {
  if (usesImSendTextArgument(text)) {
    return (
      "Invalid terminal_write arguments: agent IM replies must use " +
      "`node dist/cli/main.js im send --channel <channel> --kind status --text-stdin`. " +
      "Use stdin forms such as a quoted heredoc or input redirection instead of shell arguments. " +
      "Do not use `im send --text` from the agent."
    );
  }
  return undefined;
}

function usesImSendTextArgument(text: string): boolean {
  if (!usesImSend(text)) return false;
  if (usesImSendTextStdin(text)) return false;
  return /(?:^|\s)--text(?:=|\s|$)/u.test(text);
}

function usesImSendTextStdin(text: string): boolean {
  return usesImSend(text) && /(?:^|\s)--text-stdin(?:\s|$)/u.test(text);
}

function usesImSend(text: string): boolean {
  return /(?:^|[\s;&|])(?:node\s+\S+\s+)?im\s+send(?:\s|$)/u.test(text);
}

function isToolName(value: string): value is ToolName {
  return (MODEL_VISIBLE_TOOL_NAMES as readonly string[]).includes(value);
}

function formatToolNames(): string {
  return MODEL_VISIBLE_TOOL_NAMES.map((name) => `"${name}"`).join(", ");
}

function isTerminalKey(value: unknown): value is TerminalKey {
  return (
    typeof value === "string" &&
    (TERMINAL_KEYS as readonly string[]).includes(value)
  );
}

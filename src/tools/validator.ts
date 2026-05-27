import type {
  InternalToolCall,
  ToolCallValidation,
  ToolRequest,
  AgentObservation,
} from "../types/index.js";
import type { PtyAction, TerminalOwner } from "../terminal/types.js";
import {
  DEFAULT_PTY_ACTION_LIMITS,
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

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// ---------------------------------------------------------------------------
// ToolCallValidator
// ---------------------------------------------------------------------------

const MAX_PTY_INPUT_BYTES = DEFAULT_PTY_ACTION_LIMITS.maxWriteTextBytes;

export type ToolCallValidatorOptions = {
  terminalOwner?: TerminalOwner;
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
          "Use PTY actions such as write_text, key, input_frame, end_input, poll, status, interrupt, terminate, or restart.",
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

    const gated = gateSmallPayload(action, this.options.actionLimits);
    if (gated !== undefined) {
      return invalid(gated);
    }

    if (this.options.terminalOwner !== undefined) {
      const validation = validatePtyAction({
        action,
        owner: this.options.terminalOwner,
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
      const common = parseExpectedOwnerRevision(args);
      if (typeof common === "string") return common;
      if (!isString(args.text)) {
        return "Invalid bash tool arguments: write_text requires text.";
      }
      return { kind: "write_text", session, ...common, text: args.text };
    }
    case "key": {
      const common = parseExpectedOwnerRevision(args);
      if (typeof common === "string") return common;
      if (!isTerminalKey(args.key)) {
        return "Invalid bash tool arguments: key requires a supported terminal key.";
      }
      return { kind: "key", session, ...common, key: args.key };
    }
    case "input_frame": {
      const common = parseExpectedOwnerRevision(args);
      if (typeof common === "string") return common;
      if (!isNonEmptyString(args.receiverId)) {
        return "Invalid bash tool arguments: input_frame requires receiverId.";
      }
      const seq = parseNonNegativeInteger(args.seq, "seq");
      if (typeof seq === "string") return seq;
      if (!isString(args.dataBase64) || !isBase64(args.dataBase64)) {
        return "Invalid bash tool arguments: input_frame requires valid base64 dataBase64.";
      }
      return {
        kind: "input_frame",
        session,
        ...common,
        receiverId: args.receiverId,
        seq,
        dataBase64: args.dataBase64,
      };
    }
    case "end_input": {
      const common = parseExpectedOwnerRevision(args);
      if (typeof common === "string") return common;
      if (!isNonEmptyString(args.receiverId)) {
        return "Invalid bash tool arguments: end_input requires receiverId.";
      }
      const frames = parseNonNegativeInteger(args.frames, "frames");
      if (typeof frames === "string") return frames;
      const bytes = parseNonNegativeInteger(args.bytes, "bytes");
      if (typeof bytes === "string") return bytes;
      if (!isNonEmptyString(args.sha256)) {
        return "Invalid bash tool arguments: end_input requires sha256.";
      }
      return {
        kind: "end_input",
        session,
        ...common,
        receiverId: args.receiverId,
        frames,
        bytes,
        sha256: args.sha256,
      };
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
      if (args.expectedOwnerRevision !== undefined) {
        const common = parseExpectedOwnerRevision(args);
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

function parseExpectedOwnerRevision(
  args: Record<string, unknown>,
): { expectedOwnerRevision: number } | string {
  const value = args.expectedOwnerRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return "Invalid bash tool arguments: expectedOwnerRevision must be a non-negative integer.";
  }
  return { expectedOwnerRevision: value };
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

function gateSmallPayload(
  action: PtyAction,
  limits: Partial<PtyActionLimits> | undefined,
): string | undefined {
  const maxWriteTextBytes = limits?.maxWriteTextBytes ?? MAX_PTY_INPUT_BYTES;
  const maxFrameBytes = limits?.maxFrameBytes ?? DEFAULT_PTY_ACTION_LIMITS.maxFrameBytes;
  if (action.kind === "write_text" && utf8Bytes(action.text) > maxWriteTextBytes) {
    return (
      `Invalid bash tool arguments: write_text is above the ${maxWriteTextBytes}-byte PTY small-input limit. ` +
      "Start a receiver, then use input_frame and end_input for large payloads."
    );
  }

  if (action.kind === "input_frame" && utf8Bytes(action.dataBase64) > maxFrameBytes) {
    return `Invalid bash tool arguments: input_frame is above the ${maxFrameBytes}-byte receiver frame limit.`;
  }

  return undefined;
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

function isBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return false;
  }
  const firstPadding = value.indexOf("=");
  return firstPadding === -1 || /^=+$/u.test(value.slice(firstPadding));
}

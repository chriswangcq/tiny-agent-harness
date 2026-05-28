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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  maxHeredocPayloadBytes?: number;
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

    if (toolName === "stash_file") {
      return this.validateStashFile(toolCall.id, args);
    }

    if (toolName !== "bash") {
      return invalid(
        `Unknown tool "${toolName}". Available tools are "bash" and "stash_file".`,
      );
    }

    if ("kind" in args && args.kind !== undefined) {
      return this.validatePtyAction(toolCall.id, args);
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

    const payloadValidation = validatePtyTextPayload(action, {
      maxHeredocPayloadBytes: this.options.maxHeredocPayloadBytes,
    });
    if (payloadValidation !== undefined) {
      return invalid(payloadValidation);
    }

    const request: ToolRequest = {
      kind: "pty_action",
      toolName: "bash",
      toolCallId,
      action,
    };

    return { status: "valid", request };
  }

  private validateStashFile(
    toolCallId: string,
    args: Record<string, unknown>,
  ): ToolCallValidation {
    if (!isString(args.content)) {
      return invalid("Invalid stash_file arguments: content must be a string.");
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
      name: args.name as string | undefined,
      content: args.content,
      encoding,
      description: args.description as string | undefined,
    };

    return { status: "valid", request };
  }
}

const DEFAULT_MAX_HEREDOC_PAYLOAD_BYTES = 4096;
const DEFAULT_MAX_IM_HEREDOC_PAYLOAD_BYTES = 512;
const DEFAULT_MAX_IM_HEREDOC_PAYLOAD_LINES = 6;

function validatePtyTextPayload(
  action: PtyAction,
  options: { maxHeredocPayloadBytes?: number },
): string | undefined {
  if (action.kind !== "write_text") {
    return undefined;
  }

  if (usesImSendTextArgument(action.text)) {
    return (
      "Invalid bash tool arguments: agent IM replies must use " +
      "`node dist/cli/main.js im send --channel <channel> --kind status --text-stdin`. " +
      "Use a quoted heredoc only for simple short phrases; use `< reply.md` for longer replies. " +
      "Do not use `im send --text` from the agent."
    );
  }

  const heredoc = estimateLargestHeredocPayload(action.text);
  if (heredoc === undefined) {
    return undefined;
  }

  const maxBytes =
    options.maxHeredocPayloadBytes ?? DEFAULT_MAX_HEREDOC_PAYLOAD_BYTES;
  if (usesImSendTextStdin(action.text)) {
    if (
      heredoc.payloadBytes <= DEFAULT_MAX_IM_HEREDOC_PAYLOAD_BYTES &&
      heredoc.payloadLines <= DEFAULT_MAX_IM_HEREDOC_PAYLOAD_LINES
    ) {
      return undefined;
    }

    return (
      `Invalid bash tool arguments: IM heredoc payload is ${heredoc.payloadBytes} bytes ` +
      `across ${heredoc.payloadLines} lines, which exceeds the simple phrase limit ` +
      `(${DEFAULT_MAX_IM_HEREDOC_PAYLOAD_BYTES} bytes and ${DEFAULT_MAX_IM_HEREDOC_PAYLOAD_LINES} lines). ` +
      "For longer IM replies, stage or materialize a reply.md file, then run " +
      "`node dist/cli/main.js im send --channel <channel> --kind status --text-stdin < reply.md` " +
      "or stream the stash with `node dist/cli/main.js im send --channel <channel> --kind status --text-stdin < <(node dist/cli/main.js file cat <stashId>)` through bash."
    );
  }
  if (heredoc.payloadBytes <= maxBytes) {
    return undefined;
  }

  return (
    `Invalid bash tool arguments: heredoc payload is ${heredoc.payloadBytes} bytes, ` +
    `which exceeds the ${maxBytes} byte small-snippet limit. ` +
    "Use stash_file for generated files or large multiline payloads, then run " +
    "`node dist/cli/main.js file materialize <stashId> <target-path>` through bash."
  );
}

function usesImSendTextArgument(text: string): boolean {
  if (!usesImSend(text)) {
    return false;
  }
  if (usesImSendTextStdin(text)) {
    return false;
  }
  return /(?:^|\s)--text(?:=|\s|$)/u.test(text);
}

function usesImSendTextStdin(text: string): boolean {
  return usesImSend(text) && /(?:^|\s)--text-stdin(?:\s|$)/u.test(text);
}

function usesImSend(text: string): boolean {
  if (!/(?:^|[\s;&|])(?:node\s+\S+\s+)?im\s+send(?:\s|$)/u.test(text)) {
    return false;
  }
  return true;
}

function estimateLargestHeredocPayload(
  text: string,
): { payloadBytes: number; payloadLines: number } | undefined {
  const heredocPattern = /<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_-]*)\1|([A-Za-z_][A-Za-z0-9_-]*))/gu;
  let match: RegExpExecArray | null;
  let largest: { payloadBytes: number; payloadLines: number } | undefined;

  while ((match = heredocPattern.exec(text)) !== null) {
    const delimiter = match[2] ?? match[3];
    if (!delimiter) continue;

    const bodyStart = text.indexOf("\n", heredocPattern.lastIndex);
    if (bodyStart === -1) continue;

    const closePattern = new RegExp(
      `(?:^|\\n)${escapeForRegex(delimiter)}(?:\\r?\\n|$)`,
      "u",
    );
    const closeMatch = closePattern.exec(text.slice(bodyStart + 1));
    const body =
      closeMatch === null
        ? text.slice(bodyStart + 1)
        : text.slice(bodyStart + 1, bodyStart + 1 + closeMatch.index);
    const payload = {
      payloadBytes: Buffer.byteLength(body, "utf8"),
      payloadLines: body.length === 0 ? 0 : body.split(/\r?\n/u).length,
    };
    if (largest === undefined || payload.payloadBytes > largest.payloadBytes) {
      largest = payload;
    }
  }

  return largest !== undefined && largest.payloadBytes > 0 ? largest : undefined;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

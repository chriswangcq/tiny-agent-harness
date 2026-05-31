import type { IoWaitRequest } from "../types/environment.js";
import type { TerminalToolInput, ToolName } from "../types/index.js";
import { MODEL_VISIBLE_TOOL_NAMES } from "../types/tools.js";

// ---------------------------------------------------------------------------
// V4 DSML tokens
// ---------------------------------------------------------------------------

export const DSML = "｜DSML｜";
export const DSML_TOOL_CALLS_OPEN = `<${DSML}tool_calls>`;
export const DSML_TOOL_CALLS_CLOSE = `</${DSML}tool_calls>`;
export const DSML_INVOKE_OPEN_PREFIX = `<${DSML}invoke name="`;
const DSML_INVOKE_ECHO_PREFIX = `invoke name="`;
export const DSML_INVOKE_CLOSE = `</${DSML}invoke>`;
const DSML_PARAM_CLOSE = `</${DSML}parameter>`;
export const END_OF_SENTENCE = "<｜end▁of▁sentence｜>";

const DSML_FRAME_BOUNDARY_PREFIXES = [
  "<｜DSML",
  "</｜DSML",
  "<DSML",
  "</DSML",
  "<|DSML",
  "</|DSML",
];

const DSML_PARAM_CLOSE_VARIANTS = [
  DSML_PARAM_CLOSE,
  "</DSML｜parameter>",
  "</DSML|parameter>",
  "</|DSML|parameter>",
] as const;

export const THINKING_HARD_BOUNDARY_SEQUENCES = [
  "</think>",
  ...DSML_FRAME_BOUNDARY_PREFIXES,
  DSML_TOOL_CALLS_OPEN,
  DSML_INVOKE_OPEN_PREFIX,
  "<tool_call",
  "</tool_call>",
  "｜tool",
];

const MODEL_VISIBLE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  MODEL_VISIBLE_TOOL_NAMES,
);

const EMPTY_ARGUMENT_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  "session_observe",
  "session_list",
  "session_restart",
  "session_terminate",
]);

type Decision =
  | {
      name: ToolName;
      arguments: TerminalToolInput;
    }
  | {
      name: "io_wait";
      arguments: {
        reason?: string;
        condition: IoWaitRequest["condition"];
      };
    };

export type ParseDecisionResult =
  | { status: "valid"; decision: Decision }
  | { status: "invalid"; message: string };

export function parseDsmlDecision(rawDecision: string): ParseDecisionResult {
  const text = stripTrailingDecisionFrame(rawDecision);

  if (looksLikeDsml(text)) {
    return parseDsml(text);
  }

  return {
    status: "invalid",
    message: "Expected a V4 DSML tool call.",
  };
}

function looksLikeDsml(text: string): boolean {
  return (
    text.includes(DSML) ||
    text.includes(DSML_INVOKE_OPEN_PREFIX) ||
    text.startsWith(DSML_INVOKE_ECHO_PREFIX) ||
    /^[A-Za-z_][A-Za-z0-9_]*">\s*/.test(text)
  );
}

function parseDsml(raw: string): ParseDecisionResult {
  let text = stripTrailingDecisionFrame(raw);

  if (text.startsWith(DSML_TOOL_CALLS_OPEN)) {
    text = text.slice(DSML_TOOL_CALLS_OPEN.length).trim();
  }

  const lastInvoke = text.lastIndexOf(DSML_INVOKE_OPEN_PREFIX);
  if (lastInvoke !== -1) {
    text = text.slice(lastInvoke + DSML_INVOKE_OPEN_PREFIX.length);
  } else if (text.startsWith(DSML_INVOKE_ECHO_PREFIX)) {
    text = text.slice(DSML_INVOKE_ECHO_PREFIX.length);
  }

  // Expected: functionName">\n<params>
  const quoteClose = text.indexOf('">');
  if (quoteClose === -1) {
    return {
      status: "invalid",
      message: 'Malformed DSML tool call: missing function name terminator `">`.',
    };
  }

  const name = text.slice(0, quoteClose).trim();
  if (!name || name.length > 50) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: invalid function name.",
    };
  }

  const rest = text.slice(quoteClose + 2);
  const openParameterCount = countOccurrences(
    rest,
    `<${DSML}parameter`,
  );
  const closeParameterCount = countOccurrencesOfAny(
    rest,
    DSML_PARAM_CLOSE_VARIANTS,
  );

  if (openParameterCount > closeParameterCount) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: unclosed DSML parameter tag.",
    };
  }

  const paramsResult = parseDsmlParameters(rest);
  if (paramsResult.status === "invalid") {
    return paramsResult;
  }

  if (Object.keys(paramsResult.params).length === 0 && rest.includes("{")) {
    return {
      status: "invalid",
      message:
        "Malformed DSML tool call: expected DSML parameter tags, not raw JSON.",
    };
  }

  if (paramsResult.extraText !== "") {
    return {
      status: "invalid",
      message:
        "Malformed DSML tool call: unexpected text outside DSML parameter tags.",
    };
  }

  if (Object.keys(paramsResult.params).length > 0) {
    return buildDecision(name, paramsResult.params);
  }

  if (acceptsEmptyArguments(name)) {
    return buildDecision(name, {});
  }

  if (openParameterCount > 0) {
    return {
      status: "invalid",
      message: "Malformed DSML tool call: no complete DSML parameters found.",
    };
  }

  return {
    status: "invalid",
    message: "Malformed DSML tool call: expected DSML parameter tags.",
  };
}

function stripTrailingDecisionFrame(raw: string): string {
  let text = raw.trim();
  let changed = true;

  while (changed) {
    changed = false;
    for (const token of [
      END_OF_SENTENCE,
      DSML_TOOL_CALLS_CLOSE,
      DSML_INVOKE_CLOSE,
    ]) {
      if (text.endsWith(token)) {
        text = text.slice(0, -token.length).trim();
        changed = true;
      }
    }
  }

  return text;
}

function parseDsmlParameters(
  text: string,
):
  | { status: "valid"; params: Record<string, unknown>; extraText: string }
  | { status: "invalid"; message: string } {
  const params: Record<string, unknown> = {};
  let extraText = "";
  let cursor = 0;
  const parameterClosePattern = DSML_PARAM_CLOSE_VARIANTS.map((variant) =>
    escapeForRegex(variant),
  ).join("|");
  const paramRegex = new RegExp(
    `<${escapeForRegex(DSML)}parameter\\s+name="([^"]*)"\\s+string="(true|false)"` +
      `>([\\s\\S]*?)(?:${parameterClosePattern})`,
    "g",
  );

  let match;
  while ((match = paramRegex.exec(text)) !== null) {
    extraText += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const paramName = match[1]!;
    const isString = match[2] === "true";
    const value = match[3]!;

    if (isString) {
      params[paramName] = value;
    } else {
      try {
        params[paramName] = JSON.parse(value);
      } catch {
        return {
          status: "invalid",
          message: `Malformed DSML tool call: parameter "${paramName}" declared string="false" but did not contain valid JSON.`,
        };
      }
    }
  }
  extraText += text.slice(cursor);

  return { status: "valid", params, extraText: extraText.trim() };
}

function buildDecision(
  name: string,
  args: Record<string, unknown>,
): ParseDecisionResult {
  if (isModelVisibleToolName(name)) {
    return {
      status: "valid",
      decision: { name, arguments: args as TerminalToolInput },
    };
  }

  if (name === "io_wait") {
    if (!isIoWaitArguments(args)) {
      return {
        status: "invalid",
        message: "io_wait arguments did not match the expected schema.",
      };
    }
    return {
      status: "valid",
      decision: { name: "io_wait", arguments: args },
    };
  }

  return {
    status: "invalid",
    message: `Unsupported function: ${name}`,
  };
}

function isModelVisibleToolName(name: string): name is ToolName {
  return MODEL_VISIBLE_TOOL_NAME_SET.has(name);
}

function acceptsEmptyArguments(name: string): boolean {
  return EMPTY_ARGUMENT_TOOL_NAME_SET.has(name);
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function countOccurrencesOfAny(
  text: string,
  needles: readonly string[],
): number {
  return needles.reduce(
    (count, needle) => count + countOccurrences(text, needle),
    0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIoWaitArguments(
  value: unknown,
): value is { reason?: string; condition: IoWaitRequest["condition"] } {
  if (!isRecord(value) || !isRecord(value.condition)) {
    return false;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return false;
  }
  return true;
}

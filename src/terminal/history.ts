import type { PtyObservation } from "./types.js";

export type TerminalHistoryLimits = {
  maxStringChars: number;
};

export const DEFAULT_TERMINAL_HISTORY_LIMITS: TerminalHistoryLimits = {
  maxStringChars: 240,
};

const PAYLOAD_KEYS = new Set([
  "dataBase64",
  "payload",
  "content",
  "input",
  "rawOutput",
  "fullOutput",
  "transcript",
]);

const STABLE_STRING_KEYS = new Set([
  "kind",
  "session",
  "receiverId",
  "sha256",
  "code",
  "errorCode",
]);

export type TerminalHistoryEntry = {
  type: "terminal_observation";
  observation: PtyObservation | Record<string, unknown>;
};

export function compactTerminalHistoryEntry(
  entry: TerminalHistoryEntry,
  limits: Partial<TerminalHistoryLimits> = {},
): TerminalHistoryEntry {
  const resolved = { ...DEFAULT_TERMINAL_HISTORY_LIMITS, ...limits };
  return {
    type: entry.type,
    observation: redactPayloadFields(entry.observation, resolved) as
      | PtyObservation
      | Record<string, unknown>,
  };
}

export function redactPayloadFields(
  value: unknown,
  limits: Partial<TerminalHistoryLimits> = {},
): unknown {
  const resolved = { ...DEFAULT_TERMINAL_HISTORY_LIMITS, ...limits };
  return redactPayloadFieldsInner(value, resolved);
}

function redactPayloadFieldsInner(value: unknown, limits: TerminalHistoryLimits): unknown {
  if (typeof value === "string") {
    return compactString(value, limits.maxStringChars);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactPayloadFieldsInner(item, limits));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PAYLOAD_KEYS.has(key)) {
      result[key] = "[redacted]";
      continue;
    }
    if (typeof nested === "string" && STABLE_STRING_KEYS.has(key)) {
      result[key] = nested;
      continue;
    }
    result[key] = redactPayloadFieldsInner(nested, limits);
  }

  return result;
}

function compactString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

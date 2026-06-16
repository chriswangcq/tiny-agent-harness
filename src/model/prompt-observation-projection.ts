import type {
  SessionListObservation,
  TerminalObservation,
} from "../terminal/types.js";

export const PROMPT_REPLACEMENT_CHARACTER_MARKER =
  "[invalid utf-8 replacement character]";

export type PromptObservationProjectionDiagnostics = {
  kind: "pty_prompt_safety";
  utf8ReplacementCharacters: {
    count: number;
    marker: typeof PROMPT_REPLACEMENT_CHARACTER_MARKER;
    note: string;
  };
};

type ProjectionResult = {
  value: unknown;
  replacementCharacterCount: number;
};

export function projectObservationForPrompt(observation: unknown): unknown {
  if (
    isTerminalObservationForPrompt(observation) ||
    isSessionListObservationForPrompt(observation)
  ) {
    return projectPtyBackedObservation(observation);
  }
  return observation;
}

export function projectPromptText(text: string): ProjectionResult {
  const replacementCharacterCount = countReplacementCharacters(text);
  if (replacementCharacterCount === 0) {
    return { value: text, replacementCharacterCount };
  }
  return {
    value: text.replaceAll(
      "\uFFFD",
      PROMPT_REPLACEMENT_CHARACTER_MARKER,
    ),
    replacementCharacterCount,
  };
}

function projectPtyBackedObservation(
  observation: TerminalObservation | SessionListObservation,
): unknown {
  const projected = projectPromptValue(observation);
  if (projected.replacementCharacterCount === 0) {
    return projected.value;
  }

  return {
    ...(projected.value as Record<string, unknown>),
    promptProjection: replacementCharacterDiagnostics(
      projected.replacementCharacterCount,
    ),
  };
}

function projectPromptValue(value: unknown): ProjectionResult {
  if (typeof value === "string") {
    return projectPromptText(value);
  }
  if (Array.isArray(value)) {
    let replacementCharacterCount = 0;
    const projected = value.map((item) => {
      const itemProjection = projectPromptValue(item);
      replacementCharacterCount += itemProjection.replacementCharacterCount;
      return itemProjection.value;
    });
    return { value: projected, replacementCharacterCount };
  }
  if (isRecord(value)) {
    let replacementCharacterCount = 0;
    const projected: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const itemProjection = projectPromptValue(item);
      replacementCharacterCount += itemProjection.replacementCharacterCount;
      projected[key] = itemProjection.value;
    }
    return { value: projected, replacementCharacterCount };
  }
  return { value, replacementCharacterCount: 0 };
}

function replacementCharacterDiagnostics(
  count: number,
): PromptObservationProjectionDiagnostics {
  return {
    kind: "pty_prompt_safety",
    utf8ReplacementCharacters: {
      count,
      marker: PROMPT_REPLACEMENT_CHARACTER_MARKER,
      note:
        "PTY text contained Unicode replacement characters before prompt serialization; " +
        "raw terminal logs remain available through screen.logRef.path.",
    },
  };
}

function countReplacementCharacters(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "\uFFFD") count += 1;
  }
  return count;
}

function isTerminalObservationForPrompt(
  value: unknown,
): value is TerminalObservation {
  if (!isRecord(value)) return false;
  return (
    typeof value.currentSession === "string" &&
    typeof value.observedSession === "string" &&
    isRecord(value.terminal) &&
    typeof value.request === "string" &&
    typeof value.result === "string" &&
    typeof value.returnedToPrompt === "boolean" &&
    isRecord(value.screen)
  );
}

function isSessionListObservationForPrompt(
  value: unknown,
): value is SessionListObservation {
  if (!isRecord(value)) return false;
  return typeof value.currentSession === "string" && Array.isArray(value.sessions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

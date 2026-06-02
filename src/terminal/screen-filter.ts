export type ScreenNoiseFilterResult = {
  output: string;
  pending: string;
  state: ScreenNoiseFilterState;
};

export type ScreenNoiseFilterState = {
  pending: string;
  pendingPromptKind: ManagedShellPromptKind | null;
};

const NOISE_MARKERS = [
  "__TAH_PROMPT__",
  "__TAH_CONT__",
  "export TAH_PROMPT_NONCE=",
  "export TAH_PROMPT_SEQ=",
  "export PS1=",
  "export PS2=",
];

type ManagedShellPromptKind = "continuation";

const INITIAL_STATE: ScreenNoiseFilterState = {
  pending: "",
  pendingPromptKind: null,
};

export function stripManagedShellScreenNoise(
  value: string,
  state: ScreenNoiseFilterState = INITIAL_STATE,
): ScreenNoiseFilterResult {
  const parts = value.split(/(\n)/u);
  let output = "";
  let pending = "";
  let currentLine = state.pending;
  let pendingPromptKind = state.pendingPromptKind;

  for (const part of parts) {
    if (part === "") {
      continue;
    }
    currentLine += part;
    if (part !== "\n") {
      continue;
    }

    const noise = classifyManagedShellNoiseLine(currentLine);
    if (noise.kind === "noise") {
      pendingPromptKind = noise.nextPromptKind ?? pendingPromptKind;
    } else if (pendingPromptKind !== null) {
      output += stripManagedShellPromptChrome(
        currentLine,
        pendingPromptKind,
      );
      pendingPromptKind = null;
    } else {
      output += currentLine;
    }
    currentLine = "";
  }

  if (currentLine.length > 0) {
    if (isPotentialManagedShellNoisePrefix(currentLine)) {
      pending = currentLine;
    } else if (pendingPromptKind !== null) {
      const stripped = stripManagedShellPromptChrome(
        currentLine,
        pendingPromptKind,
      );
      output += stripped;
      pendingPromptKind = null;
    } else {
      output += currentLine;
    }
  }

  return {
    output,
    pending,
    state: { pending, pendingPromptKind },
  };
}

function classifyManagedShellNoiseLine(line: string):
  | { kind: "noise"; nextPromptKind?: ManagedShellPromptKind }
  | { kind: "content" } {
  const candidate = markerCandidate(line);
  if (candidate.startsWith("__TAH_PROMPT__")) {
    return { kind: "noise" };
  }
  if (candidate.startsWith("__TAH_CONT__")) {
    return { kind: "noise", nextPromptKind: "continuation" };
  }
  if (NOISE_MARKERS.some((marker) => candidate.startsWith(marker))) {
    return { kind: "noise" };
  }
  return { kind: "content" };
}

function isPotentialManagedShellNoisePrefix(line: string): boolean {
  const candidate = markerCandidate(line);
  return (
    candidate.length > 0 &&
    NOISE_MARKERS.some((marker) => marker.startsWith(candidate))
  );
}

function markerCandidate(line: string): string {
  const normalized = normalizeForMarkerCheck(line);
  if (NOISE_MARKERS.some((marker) => normalized.startsWith(marker))) {
    return normalized;
  }

  const markerIndex = normalized.indexOf("__TAH_");
  if (markerIndex <= 0) {
    return normalized;
  }

  const prefix = normalized.slice(0, markerIndex);
  return isShellPromptPrefix(prefix) ? normalized.slice(markerIndex) : normalized;
}

function isShellPromptPrefix(prefix: string): boolean {
  const compact = prefix.trim().replace(/\s+/gu, "");
  if (/^[>$#%]+$/u.test(compact)) {
    return true;
  }
  return /^\[[^\]\r\n]{1,200}\][>$#%]?$/u.test(compact);
}

function normalizeForMarkerCheck(line: string): string {
  return line
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .trimStart();
}

function stripManagedShellPromptChrome(
  line: string,
  promptKind: ManagedShellPromptKind,
): string {
  const { body, ending } = splitLineEnding(line);
  const stripped = stripContinuationPromptPrefix(body);
  return `${stripped}${ending}`;
}

function stripContinuationPromptPrefix(value: string): string {
  return value.replace(/^> ?/u, "").replace(/\s*__TAH_(?:CONT|PROMPT)__[^\n]*/gu, "");
}

function splitLineEnding(line: string): { body: string; ending: string } {
  if (!line.endsWith("\n")) {
    return { body: line, ending: "" };
  }

  const withoutLf = line.slice(0, -1);
  if (withoutLf.endsWith("\r")) {
    return { body: withoutLf.slice(0, -1), ending: "\r\n" };
  }
  return { body: withoutLf, ending: "\n" };
}

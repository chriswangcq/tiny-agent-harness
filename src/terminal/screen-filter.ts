export type ScreenNoiseFilterResult = {
  output: string;
  pending: string;
};

const NOISE_MARKERS = [
  "__TAH_PROMPT__",
  "__TAH_CONT__",
  "export TAH_PROMPT_NONCE=",
  "export TAH_PROMPT_SEQ=",
  "export PS1=",
  "export PS2=",
];

export function stripManagedShellScreenNoise(
  value: string,
): ScreenNoiseFilterResult {
  const parts = value.split(/(\n)/u);
  let output = "";
  let pending = "";
  let currentLine = "";

  for (const part of parts) {
    if (part === "") {
      continue;
    }
    currentLine += part;
    if (part !== "\n") {
      continue;
    }

    if (!isManagedShellNoiseLine(currentLine)) {
      output += currentLine;
    }
    currentLine = "";
  }

  if (currentLine.length > 0) {
    if (isPotentialManagedShellNoisePrefix(currentLine)) {
      pending = currentLine;
    } else {
      output += currentLine;
    }
  }

  return { output, pending };
}

function isManagedShellNoiseLine(line: string): boolean {
  const normalized = normalizeForMarkerCheck(line);
  return NOISE_MARKERS.some((marker) => normalized.startsWith(marker));
}

function isPotentialManagedShellNoisePrefix(line: string): boolean {
  const normalized = normalizeForMarkerCheck(line);
  return (
    normalized.length > 0 &&
    NOISE_MARKERS.some((marker) => marker.startsWith(normalized))
  );
}

function normalizeForMarkerCheck(line: string): string {
  return line
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .trimStart();
}

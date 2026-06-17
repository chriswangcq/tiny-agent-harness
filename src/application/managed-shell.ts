import type { ContinuationReason } from "../terminal/types.js";

export type PromptMarkerInput = {
  nonce: string;
  returnCode: number;
  cwd: string;
  promptSeq: number;
};

export type ContinuationMarkerInput = {
  nonce: string;
  reason: ContinuationReason;
  promptSeq: number;
};

export type ManagedTerminalMode = {
  kind: "noncanonical";
  minBytes: number;
  timeoutDeciseconds: number;
};

export const DEFAULT_MANAGED_TERMINAL_MODE: ManagedTerminalMode = {
  kind: "noncanonical",
  minBytes: 1,
  timeoutDeciseconds: 0,
};

export function formatPromptMarker(input: PromptMarkerInput): string {
  return [
    "__TAH_PROMPT__",
    `nonce=${encodeMarkerField(input.nonce)}`,
    `rc=${input.returnCode}`,
    `cwd=${encodeMarkerField(input.cwd)}`,
    `seq=${input.promptSeq}`,
  ].join(" ");
}

export function formatContinuationMarker(input: ContinuationMarkerInput): string {
  return [
    "__TAH_CONT__",
    `nonce=${encodeMarkerField(input.nonce)}`,
    `reason=${input.reason}`,
    `seq=${input.promptSeq}`,
  ].join(" ");
}

export function buildManagedShellInitSnippet(input: {
  nonce: string;
  terminalMode?: ManagedTerminalMode;
}): string {
  const encodedNonce = encodeMarkerField(input.nonce);
  const quotedNonce = shellSingleQuote(encodedNonce);
  const terminalMode = input.terminalMode ?? DEFAULT_MANAGED_TERMINAL_MODE;
  return [
    "set +H",
    buildTerminalModeCommand(terminalMode),
    `export TAH_PROMPT_NONCE=${quotedNonce}`,
    "export TAH_PROMPT_SEQ=0",
    "export TAH_PROMPT_RC=0",
    "export PROMPT_COMMAND='TAH_PROMPT_RC=$?; TAH_PROMPT_SEQ=$((TAH_PROMPT_SEQ + 1))'",
    "export PS1='__TAH_PROMPT__ nonce=${TAH_PROMPT_NONCE} rc=${TAH_PROMPT_RC} cwd=\\w seq=${TAH_PROMPT_SEQ}'$'\\n''[\\u@\\h:\\w]\\$ '",
    "export PS2='__TAH_CONT__ nonce=${TAH_PROMPT_NONCE} reason=unknown seq=${TAH_PROMPT_SEQ}'$'\\n''> '",
  ].join("\n");
}

export function encodeMarkerField(value: string): string {
  return encodeURIComponent(value).replaceAll("'", "%27");
}

function buildTerminalModeCommand(mode: ManagedTerminalMode): string {
  switch (mode.kind) {
    case "noncanonical":
      return [
        "stty",
        "-icanon",
        "min",
        shellWord(String(mode.minBytes)),
        "time",
        shellWord(String(mode.timeoutDeciseconds)),
        "||",
        "{",
        "rc=$?;",
        "printf",
        shellSingleQuote("__TAH_TERMINAL_MODE_ERROR__ rc=%s\\n"),
        '"$rc";',
        "exit",
        '"$rc";',
        "}",
      ].join(" ");
  }
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) {
    return value;
  }
  return shellSingleQuote(value);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

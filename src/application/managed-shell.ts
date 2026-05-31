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

export function buildManagedShellInitSnippet(input: { nonce: string }): string {
  const encodedNonce = encodeMarkerField(input.nonce);
  const quotedNonce = shellSingleQuote(encodedNonce);
  return [
    `export TAH_PROMPT_NONCE=${quotedNonce}`,
    "export TAH_PROMPT_SEQ=0",
    "export PS1='__TAH_PROMPT__ nonce='\"$TAH_PROMPT_NONCE\"' rc=$? cwd=\\w seq='\"$TAH_PROMPT_SEQ\"$'\\n[\\u@\\h:\\w]\\$ '",
    "export PS2='__TAH_CONT__ nonce='\"$TAH_PROMPT_NONCE\"' reason=unknown seq='\"$TAH_PROMPT_SEQ\"$'\\n> '",
  ].join("\n");
}

export function encodeMarkerField(value: string): string {
  return encodeURIComponent(value).replaceAll("'", "%27");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

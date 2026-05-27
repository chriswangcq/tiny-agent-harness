import type { ContinuationReason, ReceiverMode } from "../terminal/types.js";

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

export type ReceiverReadyMarkerInput = {
  nonce: string;
  receiverId: string;
  mode: ReceiverMode;
  maxFrameBytes: number;
  nextSeq: number;
  commandLine: string;
  bytesReceived?: number;
  expectedSha256?: string;
};

export type ReceiverAckMarkerInput = {
  nonce: string;
  receiverId: string;
  seq: number;
  bytes: number;
};

export type ReceiverDoneMarkerInput = {
  nonce: string;
  receiverId: string;
  bytes: number;
  sha256: string;
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

export function formatReceiverReadyMarker(input: ReceiverReadyMarkerInput): string {
  const fields = [
    "__TAH_RECEIVER_READY__",
    `nonce=${encodeMarkerField(input.nonce)}`,
    `id=${encodeMarkerField(input.receiverId)}`,
    `mode=${input.mode}`,
    `max=${input.maxFrameBytes}`,
    `next=${input.nextSeq}`,
    `command=${encodeMarkerField(input.commandLine)}`,
  ];

  if (input.bytesReceived !== undefined) {
    fields.push(`bytes=${input.bytesReceived}`);
  }
  if (input.expectedSha256 !== undefined) {
    fields.push(`sha256=${input.expectedSha256}`);
  }

  return fields.join(" ");
}

export function formatReceiverAckMarker(input: ReceiverAckMarkerInput): string {
  return [
    "__TAH_RECEIVER_ACK__",
    `nonce=${encodeMarkerField(input.nonce)}`,
    `id=${encodeMarkerField(input.receiverId)}`,
    `seq=${input.seq}`,
    `bytes=${input.bytes}`,
  ].join(" ");
}

export function formatReceiverDoneMarker(input: ReceiverDoneMarkerInput): string {
  return [
    "__TAH_RECEIVER_DONE__",
    `nonce=${encodeMarkerField(input.nonce)}`,
    `id=${encodeMarkerField(input.receiverId)}`,
    `bytes=${input.bytes}`,
    `sha256=${input.sha256}`,
  ].join(" ");
}

export function buildManagedShellInitSnippet(input: { nonce: string }): string {
  const encodedNonce = encodeMarkerField(input.nonce);
  const quotedNonce = shellSingleQuote(encodedNonce);
  return [
    `export TAH_PROMPT_NONCE=${quotedNonce}`,
    "export TAH_PROMPT_SEQ=0",
    "export PS1='__TAH_PROMPT__ nonce='\"$TAH_PROMPT_NONCE\"' rc=$? cwd=\\w seq='\"$TAH_PROMPT_SEQ\"$'\\n$ '",
    "export PS2='__TAH_CONT__ nonce='\"$TAH_PROMPT_NONCE\"' reason=unknown seq='\"$TAH_PROMPT_SEQ\"$'\\n> '",
  ].join("\n");
}

export function encodeMarkerField(value: string): string {
  return encodeURIComponent(value).replaceAll("'", "%27");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

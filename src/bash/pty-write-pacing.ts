export type PtyWritePacing = {
  chunkBytes: number;
  interChunkDelayMs: number;
  reason: "short" | "protected";
};

export const FAST_PTY_WRITE_CHUNK_BYTES = 1024;
export const PROTECTED_PTY_WRITE_CHUNK_BYTES = 256;
export const PROTECTED_PTY_WRITE_DELAY_MS = 5;
export const PROTECTED_PTY_WRITE_THRESHOLD_BYTES = 1024;

export function planPtyWrite(text: string): PtyWritePacing {
  if (
    Buffer.byteLength(text, "utf8") > PROTECTED_PTY_WRITE_THRESHOLD_BYTES ||
    containsShellHeredoc(text)
  ) {
    return {
      chunkBytes: PROTECTED_PTY_WRITE_CHUNK_BYTES,
      interChunkDelayMs: PROTECTED_PTY_WRITE_DELAY_MS,
      reason: "protected",
    };
  }

  return {
    chunkBytes: FAST_PTY_WRITE_CHUNK_BYTES,
    interChunkDelayMs: 0,
    reason: "short",
  };
}

export function chunkTextByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current.length > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }

    current += char;
    currentBytes += charBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function containsShellHeredoc(text: string): boolean {
  return /<<-?\s*(?:(['"])[A-Za-z_][A-Za-z0-9_-]*\1|[A-Za-z_][A-Za-z0-9_-]*)/u.test(
    text,
  );
}

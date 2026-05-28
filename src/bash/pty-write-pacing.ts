export type PtyWritePacing = {
  chunkBytes: number;
  interChunkDelayMs: number;
  reason: "protected";
};

export const PROTECTED_PTY_WRITE_CHUNK_BYTES = 128;
export const PROTECTED_PTY_WRITE_DELAY_MS = 10;

export function planPtyWrite(_text: string): PtyWritePacing {
  return {
    chunkBytes: PROTECTED_PTY_WRITE_CHUNK_BYTES,
    interChunkDelayMs: PROTECTED_PTY_WRITE_DELAY_MS,
    reason: "protected",
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

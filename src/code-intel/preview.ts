import * as fs from "node:fs";
import type { SourceRange } from "./types.js";

export function readPreview(
  filePath: string,
  range: SourceRange,
  previewLines: number,
): string | undefined {
  if (previewLines <= 0) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, range.start.line);
  const endLine = Math.min(lines.length, startLine + previewLines - 1);
  return lines.slice(startLine - 1, endLine).join("\n");
}

export function truncateText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, truncated: false };
  }

  let bytes = 0;
  let output = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (bytes + charBytes > maxBytes) {
      return { text: output, truncated: true };
    }
    output += char;
    bytes += charBytes;
  }
  return { text: output, truncated: false };
}

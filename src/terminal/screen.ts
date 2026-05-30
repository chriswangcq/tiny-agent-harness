/// <reference path="../types/wcwidth.d.ts" />

import wcwidth from "wcwidth";

export type TerminalViewportSize = {
  rows: number;
  cols: number;
};

export function normalizeTerminalScreenText(
  text: string,
  viewport: TerminalViewportSize,
): string {
  const rows = positiveInteger(viewport.rows);
  const cols = positiveInteger(viewport.cols);
  if (rows === undefined || cols === undefined) return "";

  const wrappedRows = normalizeLineEndings(text).split("\n").flatMap((line) =>
    wrapTerminalRow(line, cols),
  );
  return wrappedRows.slice(-rows).join("\n");
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function wrapTerminalRow(line: string, cols: number): string[] {
  if (line.length === 0) return [""];

  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of Array.from(line)) {
    const charWidth = Math.max(0, wcwidth(char));
    if (current && currentWidth + charWidth > cols) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth = Math.min(cols, currentWidth + charWidth);
  }
  rows.push(current);
  return rows;
}

function positiveInteger(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

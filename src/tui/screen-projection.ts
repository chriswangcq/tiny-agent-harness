// ─── Screen Grid Projection ───────────────────────────────────────────
//
// Pure-function screen grid construction from raw PTY bytes.
// Handles: printable ASCII, UTF-8/Unicode, wcwidth, backspace, TAB, CR, LF, ANSI CSI.

import wcwidth from "wcwidth";

export interface ScreenGrid {
  rows: number;
  cols: number;
  cells: string[][];
}

export interface CursorState {
  row: number;
  col: number;
  savedRow?: number;
  savedCol?: number;
}

function createGrid(rows: number, cols: number): string[][] {
  const cells: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(" ");
    }
    cells.push(row);
  }
  return cells;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scrollUp(cells: string[][], rows: number, cols: number): void {
  for (let r = 1; r < rows; r++)
    for (let c = 0; c < cols; c++)
      cells[r - 1][c] = cells[r][c];
  for (let c = 0; c < cols; c++)
    cells[rows - 1][c] = " ";
}

function eraseDisplay(
  cells: string[][], rows: number, cols: number,
  cursorRow: number, cursorCol: number, mode: number,
): void {
  if (mode === 2) {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        cells[r][c] = " ";
  } else if (mode === 0) {
    for (let c = cursorCol; c < cols; c++)
      cells[cursorRow][c] = " ";
    for (let r = cursorRow + 1; r < rows; r++)
      for (let c = 0; c < cols; c++)
        cells[r][c] = " ";
  }
}

function eraseLine(
  cells: string[][], cols: number,
  cursorRow: number, cursorCol: number, mode: number,
): void {
  if (mode === 2) {
    for (let c = 0; c < cols; c++)
      cells[cursorRow][c] = " ";
  } else if (mode === 0) {
    for (let c = cursorCol; c < cols; c++)
      cells[cursorRow][c] = " ";
  }
}

type AnsiState = "normal" | "esc" | "csi";

function wrapIfNeeded(
  cursor: CursorState, cells: string[][],
  safeRows: number, safeCols: number,
): void {
  cursor.col = 0;
  cursor.row++;
  if (cursor.row >= safeRows) {
    scrollUp(cells, safeRows, safeCols);
    cursor.row = safeRows - 1;
  }
}

/** Write a character with given visual width to the grid at cursor */
function writeChar(
  cells: string[][], cursor: CursorState,
  safeRows: number, safeCols: number,
  ch: string, charWidth: number,
): void {
  if (cursor.col + charWidth > safeCols) {
    wrapIfNeeded(cursor, cells, safeRows, safeCols);
  }
  cells[cursor.row][cursor.col] = ch;
  cursor.col++;
  // Mark continuation columns for wide chars
  for (let w = 1; w < charWidth && cursor.col < safeCols; w++) {
    cells[cursor.row][cursor.col] = "";
    cursor.col++;
  }
}

export function buildScreenGrid(
  rawBytes: string, rows: number, cols: number,
): ScreenGrid {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const cells = createGrid(safeRows, safeCols);
  const cursor: CursorState = { row: 0, col: 0 };
  let state: AnsiState = "normal";
  let params = "";

  let i = 0;
  while (i < rawBytes.length) {
    const code = rawBytes.charCodeAt(i);
    const ch = rawBytes[i];

    // ── ANSI escape handling ──
    if (state === "esc") {
      if (ch === "[") { state = "csi"; params = ""; i++; continue; }
      state = "normal"; i++; continue;
    }

    if (state === "csi") {
      if (code >= 0x30 && code <= 0x3f) { params += ch; i++; continue; }
      if (code >= 0x20 && code <= 0x2f) { i++; continue; }
      if (code >= 0x40 && code <= 0x7e) {
        handleCsiCommand(cells, cursor, safeRows, safeCols, ch, params);
        state = "normal"; params = ""; i++; continue;
      }
      state = "normal"; params = ""; i++; continue;
    }

    if (code === 0x1b) { state = "esc"; i++; continue; }

    // ── Control characters ──
    if (code === 0x0d) { cursor.col = 0; i++; continue; }
    if (code === 0x0a) {
      cursor.col = 0; cursor.row++;
      if (cursor.row >= safeRows) {
        scrollUp(cells, safeRows, safeCols);
        cursor.row = safeRows - 1;
      }
      i++; continue;
    }
    if (code === 0x08) {
      if (cursor.col > 0) { cursor.col--; cells[cursor.row][cursor.col] = " "; }
      i++; continue;
    }
    if (code === 0x09) {
      cursor.col = clamp((Math.floor(cursor.col / 8) + 1) * 8, 0, safeCols);
      i++; continue;
    }
    // Filter other C0 control chars
    if (code < 0x20) { i++; continue; }

    // ── Printable (ASCII or Unicode) ──
    if (code <= 0x7e) {
      writeChar(cells, cursor, safeRows, safeCols, ch, 1);
      i++; continue;
    }

    // Unicode codepoint (already decoded from UTF-8 by JS runtime)
    // Handle surrogate pairs for characters beyond BMP
    let cp: number;
    let fullCh: string;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < rawBytes.length) {
      const low = rawBytes.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        fullCh = rawBytes.substring(i, i + 2);
        i++; // skip low surrogate
      } else {
        // Lone high surrogate - invalid
        i++; continue;
      }
    } else {
      cp = code;
      fullCh = ch;
    }

    const charWidth = Math.max(1, wcwidth(fullCh));
    writeChar(cells, cursor, safeRows, safeCols, fullCh, charWidth);
    i++;
  }

  return { rows: safeRows, cols: safeCols, cells };
}

function parseCsiParams(params: string): number[] {
  if (!params) return [];
  return params.split(";").map((s) => {
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  });
}

function defaultParam(params: number[], index: number, fallback: number): number {
  return params[index] !== undefined && params[index] !== 0 ? params[index] : fallback;
}

function handleCsiCommand(
  cells: string[][], cursor: CursorState, rows: number, cols: number,
  finalByte: string, params: string,
): void {
  const args = parseCsiParams(params);
  switch (finalByte) {
    case "A": cursor.row = clamp(cursor.row - defaultParam(args, 0, 1), 0, rows - 1); break;
    case "B": cursor.row = clamp(cursor.row + defaultParam(args, 0, 1), 0, rows - 1); break;
    case "C": cursor.col = clamp(cursor.col + defaultParam(args, 0, 1), 0, cols - 1); break;
    case "D": cursor.col = clamp(cursor.col - defaultParam(args, 0, 1), 0, cols - 1); break;
    case "H": {
      cursor.row = clamp(defaultParam(args, 0, 1) - 1, 0, rows - 1);
      cursor.col = clamp(defaultParam(args, 1, 1) - 1, 0, cols - 1);
      break;
    }
    case "J": eraseDisplay(cells, rows, cols, cursor.row, cursor.col, defaultParam(args, 0, 0)); break;
    case "K": eraseLine(cells, cols, cursor.row, cursor.col, defaultParam(args, 0, 0)); break;
    case "m": break;
    default: break;
  }
}

export function screenGridToText(grid: ScreenGrid): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.rows; r++) {
    const row = grid.cells[r].join("").replace(/ +$/, "");
    lines.push(row);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Convert grid to display-safe lines for TUI projection. */
export function screenGridToDisplayLines(
  grid: ScreenGrid,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (let r = 0; r < grid.rows; r++) {
    const row = grid.cells[r].join("").replace(/ +$/, "");
    if (row.length <= maxWidth) {
      lines.push(row || " ");
    } else {
      // Wrap long rows
      for (let c = 0; c < row.length; c += maxWidth) {
        lines.push(row.slice(c, c + maxWidth));
      }
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].replace(/ +$/, "") === "") {
    lines.pop();
  }
  if (lines.length === 0) lines.push(" ");
  return lines;
}

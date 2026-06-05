import { describe, it, expect } from "vitest";
import {
  buildScreenGrid,
  screenGridToText,
  type ScreenGrid,
  type CursorState,
} from "../../src/tui/screen-projection.js";

describe("buildScreenGrid", () => {
  it("creates an empty grid of spaces", () => {
    const grid = buildScreenGrid("", 3, 5);
    expect(grid.rows).toBe(3);
    expect(grid.cols).toBe(5);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        expect(grid.cells[r][c]).toBe(" ");
      }
    }
  });

  it("writes a single printable character at cursor", () => {
    const grid = buildScreenGrid("A", 2, 4);
    expect(grid.cells[0][0]).toBe("A");
    // cursor advanced
    expect(grid.cells[0][1]).toBe(" ");
  });

  it("writes multiple characters on the same row", () => {
    const grid = buildScreenGrid("Hello", 1, 10);
    expect(grid.cells[0][0]).toBe("H");
    expect(grid.cells[0][1]).toBe("e");
    expect(grid.cells[0][2]).toBe("l");
    expect(grid.cells[0][3]).toBe("l");
    expect(grid.cells[0][4]).toBe("o");
  });

  it("fills exactly to cols without overflowing", () => {
    const grid = buildScreenGrid("AB", 1, 2);
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[0][1]).toBe("B");
    // no wrap in this child, so extra char would be silently dropped
  });

  it("backspace at col 0 is a no-op", () => {
    const grid = buildScreenGrid("\x08A", 1, 5);
    // backspace does nothing at col 0, then writes A
    expect(grid.cells[0][0]).toBe("A");
  });

  it("backspace clears and moves cursor left", () => {
    const grid = buildScreenGrid("AB\x08", 1, 5);
    // A at 0, B at 1, backspace: clear col 0 (no, col moves to 0, clears col 1, then cursor at 0)
    // Actually: AB written, cursor at col 2. Backspace: col-- to 1, clear col 1
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[0][1]).toBe(" "); // cleared by backspace
  });

  it("backspace then write overwrites", () => {
    const grid = buildScreenGrid("AB\x08C", 1, 5);
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[0][1]).toBe("C"); // B overwritten by C
  });

  it("TAB advances to next modulo-8 stop", () => {
    const grid = buildScreenGrid("\tA", 1, 10);
    // TAB from col 0 → col 8
    expect(grid.cells[0][8]).toBe("A");
    // cols 0-7 should be spaces
    for (let c = 0; c < 8; c++) {
      expect(grid.cells[0][c]).toBe(" ");
    }
  });

  it("TAB at col 7 moves to col 8", () => {
    const grid = buildScreenGrid("XXXXXXX\tA", 1, 10);
    // "XXXXXXX" fills cols 0-6, cursor at 7
    // TAB from col 7 → moves to col 8
    expect(grid.cells[0][8]).toBe("A");
    expect(grid.cells[0][7]).toBe(" "); // TAB didn't write here
  });

  it("TAB near end of line is bounded", () => {
    const grid = buildScreenGrid("\t", 1, 5);
    // TAB from col 0 → would go to col 8 but bounded by cols=5, so stays at max col
    // Actually: TAB advances as far as possible, bounded at cols
    // COL now at min(8, cols)... but we don't wrap, so col stays at cols (clamped)
    // No character written
    expect(grid.cells[0][0]).toBe(" ");
  });

  it("writes to multiple rows via explicit newlines (LF)", () => {
    // LF is separate child, but let's verify basic row isolation
    const grid = buildScreenGrid("A", 2, 3);
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[1][0]).toBe(" "); // second row untouched
  });

  it("ignores non-printable control characters", () => {
    const grid = buildScreenGrid("A\x01\x02\x03B", 1, 5);
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[0][1]).toBe("B");
  });
});

describe("screenGridToText", () => {
  it("empty grid produces empty string", () => {
    const grid = buildScreenGrid("", 2, 3);
    expect(screenGridToText(grid)).toBe("");
  });

  it("single row with content", () => {
    const grid = buildScreenGrid("Hello", 1, 10);
    expect(screenGridToText(grid)).toBe("Hello");
  });

  it("multi-row trims trailing empty rows", () => {
    const grid = buildScreenGrid("A", 3, 5);
    // Only row 0 has content
    expect(screenGridToText(grid)).toBe("A");
  });

  it("multiple rows with content", () => {
    // Build grid manually for multi-row test
    const grid: ScreenGrid = {
      rows: 2,
      cols: 5,
      cells: [
        ["H", "i", " ", " ", " "],
        ["o", "k", " ", " ", " "],
      ],
    };
    expect(screenGridToText(grid)).toBe("Hi\nok");
  });

  it("trims trailing spaces from rows", () => {
    const grid: ScreenGrid = {
      rows: 1,
      cols: 10,
      cells: [["A", "B", " ", " ", " ", " ", " ", " ", " ", " "]],
    };
    expect(screenGridToText(grid)).toBe("AB");
  });
});

describe("buildScreenGrid CR/LF handling", () => {
  it("CR returns cursor to column 0", () => {
    const grid = buildScreenGrid("AB\rC", 1, 5);
    expect(grid.cells[0][0]).toBe("C");
    expect(grid.cells[0][1]).toBe("B"); // B was at col 1, C overwrote col 0
  });

  it("LF advances row", () => {
    const grid = buildScreenGrid("A\nB", 3, 5);
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[1][0]).toBe("B");
  });

  it("CRLF combo", () => {
    const grid = buildScreenGrid("AB\r\nC", 3, 5);
    // AB written on row 0, CR moves to col 0, LF moves to row 1, C at row 1 col 0
    expect(grid.cells[0][0]).toBe("A");
    expect(grid.cells[0][1]).toBe("B");
    expect(grid.cells[1][0]).toBe("C");
  });

  it("LF at bottom row scrolls", () => {
    const grid = buildScreenGrid("A\nB\nC", 2, 5);
    // A on row 0, LF -> row 1, B on row 1, LF -> scroll, row 0 = "B", row 1 = "C"
    expect(grid.cells[0][0]).toBe("B");
    expect(grid.cells[1][0]).toBe("C");
  });
});

describe("buildScreenGrid ANSI CSI handling", () => {
  it("CUP sets cursor position (1-based)", () => {
    const grid = buildScreenGrid("\x1b[2;3HA", 3, 5);
    // CUP to row 2, col 3 (1-based) => grid row 1, col 2
    expect(grid.cells[1][2]).toBe("A");
  });

  it("CUP with default row/col", () => {
    const grid = buildScreenGrid("HELLO\x1b[HB", 1, 5);
    // CUP with no args defaults to 1;1 => grid row 0, col 0. B overwrites H.
    expect(grid.cells[0][0]).toBe("B");
  });

  it("CUU moves cursor up", () => {
    const grid = buildScreenGrid("\n\n\x1b[2AX", 3, 5);
    // Two LFs advance to row 2, CUU(2) moves up to row 0, X at row 0 col 0
    expect(grid.cells[0][0]).toBe("X");
  });

  it("CUD moves cursor down", () => {
    const grid = buildScreenGrid("\x1b[2BX", 3, 5);
    // CUD(2) moves from row 0 to row 2, X at row 2 col 0
    expect(grid.cells[2][0]).toBe("X");
  });

  it("CUF moves cursor forward", () => {
    const grid = buildScreenGrid("\x1b[3CX", 1, 10);
    // CUF(3) moves col from 0 to 3, X at col 3
    expect(grid.cells[0][3]).toBe("X");
  });

  it("CUB moves cursor backward", () => {
    const grid = buildScreenGrid("ABCD\x1b[2DX", 1, 10);
    // ABCD writes cols 0-3, cursor at 4. CUB(3) moves to col 2. X at col 2.
    expect(grid.cells[0][2]).toBe("X");
  });

  it("ED(2) clears entire screen", () => {
    const grid = buildScreenGrid("HELLO\x1b[2J", 2, 5);
    // After ED(2), all cells should be spaces
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 5; c++) {
        expect(grid.cells[r][c]).toBe(" ");
      }
    }
  });

  it("ED(0) clears from cursor to end", () => {
    const grid = buildScreenGrid("HELLO\x1b[3D\x1b[J", 2, 5);
    // HELLO writes cols 0-4, CUB(3) moves to col 2, ED(0) clears from col 2 to end
    // row 0: "HE   "
    expect(grid.cells[0][0]).toBe("H");
    expect(grid.cells[0][1]).toBe("E");
    expect(grid.cells[0][2]).toBe(" ");
    expect(grid.cells[0][3]).toBe(" ");
    expect(grid.cells[0][4]).toBe(" ");
  });

  it("EL(2) clears entire current row", () => {
    const grid = buildScreenGrid("HELLO\x1b[2K", 2, 5);
    // Row 0 should be all spaces after EL(2)
    for (let c = 0; c < 5; c++) {
      expect(grid.cells[0][c]).toBe(" ");
    }
  });

  it("SGR sequences are discarded", () => {
    const grid = buildScreenGrid("\x1b[31m\x1b[1mHELLO\x1b[0m", 1, 10);
    // Colors should be ignored, HELLO written normally
    expect(grid.cells[0][0]).toBe("H");
    expect(grid.cells[0][4]).toBe("O");
  });

  it("scroll on cursor overflow", () => {
    const grid = buildScreenGrid("A\nB\nC\nD", 3, 5);
    // 4 lines on a 3-row grid: row 0="B", row 1="C", row 2="D"
    expect(grid.cells[0][0]).toBe("B");
    expect(grid.cells[1][0]).toBe("C");
    expect(grid.cells[2][0]).toBe("D");
  });

  it("malformed escape sequence discarded", () => {
    const grid = buildScreenGrid("A\x1b[999B", 1, 5);
    // Malformed or incomplete - should still have A, no crash
    expect(grid.cells[0][0]).toBe("A");
  });
});

describe("buildScreenGrid UTF-8 and wcwidth", () => {
  it("writes CJK character (wcwidth 2)", () => {
    const grid = buildScreenGrid("\u4e2d", 1, 10);
    // 中 (U+4E2D) has wcwidth 2
    expect(grid.cells[0][0]).toBe("\u4e2d");
    expect(grid.cells[0][1]).toBe(""); // continuation column for wide char
  });

  it("CJK char at end of line wraps", () => {
    const grid = buildScreenGrid("1234\u4e2d", 2, 5);
    // "1234" fills cols 0-3, cursor at 4. 中 needs 2 cols (4+2=6 > 5) → wrap to row 1
    expect(grid.cells[0][0]).toBe("1");
    expect(grid.cells[0][1]).toBe("2");
    expect(grid.cells[0][2]).toBe("3");
    expect(grid.cells[0][3]).toBe("4");
    expect(grid.cells[1][0]).toBe("\u4e2d");
  });

  it("ascii char wraps at end of line", () => {
    const grid = buildScreenGrid("12345A", 2, 5);
    // "12345" fills cols 0-4, cursor at 5. A: cursor.col(5) >= cols(5) → wrap
    expect(grid.cells[0][0]).toBe("1");
    expect(grid.cells[1][0]).toBe("A");
  });

});

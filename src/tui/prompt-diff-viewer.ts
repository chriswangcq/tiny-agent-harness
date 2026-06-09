// ─── TUI Prompt Diff Viewer ─────────────────────────────────────────
//
// Pure domain helper for listing and comparing promptRef artifacts
// without loading large prompt content into model context or TUI
// loop frame detail panes.
//
// This module is a building block. It does NOT:
// - Change any model-visible tool
// - Modify TUI renderers
// - Write to transcript or model context
// - Scan filesystem implicitly (caller provides run directory)

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────

/** A single prompt artifact entry discovered in a run's debug/prompts directory. */
export type PromptArtifactEntry = {
  /** The step number parsed from the filename, or -1 if unparseable. */
  step: number;
  /** The original filename (not full path). */
  fileName: string;
  /** Relative path from the run directory. */
  relativePath: string;
  /** File size in bytes. */
  fileSize: number;
  /** Estimated token count using simple character/4 heuristic. */
  estimatedTokens: number;
};

/** A single diff line. */
export type DiffLine = {
  /** "+" for added, "-" for removed, " " for context. */
  kind: "+" | "-" | " ";
  /** The line text without trailing newline. */
  text: string;
  /** 1-based line number in file A (removed/context) or B (added/context). */
  lineNumber: number;
};

/** Structured comparison of two prompt artifact files. */
export type PromptComparison = {
  /** True if the two files have identical content. */
  identical: boolean;
  /** Size of file A in bytes. */
  sizeA: number;
  /** Size of file B in bytes. */
  sizeB: number;
  /** sizeA - sizeB. Positive means A is larger. */
  sizeDelta: number;
  /** Estimated token count for file A. */
  estimatedTokensA: number;
  /** Estimated token count for file B. */
  estimatedTokensB: number;
  /** estimatedTokensA - estimatedTokensB. */
  tokenDelta: number;
  /** Line-level diff entries. Empty if identical. */
  diffLines: DiffLine[];
  /** Human-readable summary for TUI display. */
  summary?: string;
  /** Error message if comparison failed (e.g. file not found). */
  error?: string;
};

// ─── Constants ────────────────────────────────────────────────────

/** Max lines to include in the diffLines output to avoid large payloads. */
const MAX_DIFF_LINES = 500;

/** Max bytes per read chunk for file comparison. */
const CHUNK_SIZE = 64 * 1024; // 64KB

// ─── Public API ───────────────────────────────────────────────────

/**
 * Estimate the number of tokens in text using a simple characters/4 heuristic.
 * This is intentionally approximate; exact tokenization is out of scope.
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * List prompt artifact files in a run's `debug/prompts/` directory.
 *
 * Only files matching `*.prompt.txt` are included. Results are sorted
 * by step number ascending. Non-numeric step prefixes produce step = -1.
 *
 * @param runDir - Absolute path to the run directory (e.g. `~/.tiny-agent/projects/<projectId>/runs/<runId>`)
 * @returns Sorted array of artifact entries, or empty array if the directory does not exist.
 */
export function listPromptArtifacts(runDir: string): PromptArtifactEntry[] {
  const promptsDir = path.join(runDir, "debug", "prompts");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(promptsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: PromptArtifactEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".prompt.txt")) continue;

    const fullPath = path.join(promptsDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    // Parse step number from filename pattern: "step-NNNN-*"
    const stepMatch = entry.name.match(/^step-(\d+)-/);
    const step = stepMatch ? parseInt(stepMatch[1]!, 10) : -1;

    const content = tryReadFileHead(fullPath, stat.size);
    const estimatedTokens = estimateTokenCount(content);

    results.push({
      step,
      fileName: entry.name,
      relativePath: path.join("debug", "prompts", entry.name),
      fileSize: stat.size,
      estimatedTokens,
    });
  }

  results.sort((a, b) => a.step - b.step);
  return results;
}

/**
 * Compare two prompt artifact files and return a structured diff.
 *
 * Files are read in bounded chunks to avoid loading entire files into memory.
 * The diffLines output is capped at `MAX_DIFF_LINES` to prevent large payloads.
 *
 * @param pathA - Absolute path to the first file ("A", the reference).
 * @param pathB - Absolute path to the second file ("B", the variant).
 * @returns Structured comparison result.
 */
export function comparePromptArtifacts(
  pathA: string,
  pathB: string,
): PromptComparison {
  const result: PromptComparison = {
    identical: false,
    sizeA: 0,
    sizeB: 0,
    sizeDelta: 0,
    estimatedTokensA: 0,
    estimatedTokensB: 0,
    tokenDelta: 0,
    diffLines: [],
  };

  // Read file contents with error handling
  let contentA: string;
  let contentB: string;
  try {
    contentA = fs.readFileSync(pathA, "utf-8");
    contentB = fs.readFileSync(pathB, "utf-8");
  } catch (err) {
    result.error = String(err);
    result.summary = `Error comparing files: ${result.error}`;
    return result;
  }

  result.sizeA = Buffer.byteLength(contentA, "utf-8");
  result.sizeB = Buffer.byteLength(contentB, "utf-8");
  result.sizeDelta = result.sizeA - result.sizeB;
  result.estimatedTokensA = estimateTokenCount(contentA);
  result.estimatedTokensB = estimateTokenCount(contentB);
  result.tokenDelta = result.estimatedTokensA - result.estimatedTokensB;

  if (contentA === contentB) {
    result.identical = true;
    result.summary = buildSummary(result);
    return result;
  }

  // Compute line-level diff
  const linesA = contentA.split("\n");
  const linesB = contentB.split("\n");
  result.diffLines = computeLineDiff(linesA, linesB);

  result.summary = buildSummary(result);
  return result;
}

// ─── Private helpers ──────────────────────────────────────────────

function tryReadFileHead(filePath: string, fileSize: number): string {
  // For small files, read the whole thing. For large files, read first chunk only
  // for token estimation purposes.
  const readSize = Math.min(fileSize, CHUNK_SIZE);
  try {
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, readSize, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Simple Myers-like diff producing a unified-diff-style line list.
 *
 * This is a simplified longest-common-subsequence diff for line arrays.
 * It does NOT guarantee minimal diffs but is O(N*M) bounded and suitable
 * for prompt comparison where files are typically < 10K lines.
 */
function computeLineDiff(linesA: string[], linesB: string[]): DiffLine[] {
  const result: DiffLine[] = [];

  // Build LCS table for small-to-medium files
  const m = linesA.length;
  const n = linesB.length;

  // Cap matrix size for performance
  const maxLen = Math.min(m, 5000);
  const maxLenB = Math.min(n, 5000);

  if (m > 5000 || n > 5000) {
    // Fall back to simple line-by-line comparison for very large files
    const maxLines = Math.min(m, n);
    for (let i = 0; i < maxLines && result.length < MAX_DIFF_LINES; i++) {
      if (linesA[i] !== linesB[i]) {
        if (i < m) result.push({ kind: "-", text: linesA[i]!, lineNumber: i + 1 });
        if (i < n) result.push({ kind: "+", text: linesB[i]!, lineNumber: i + 1 });
      }
    }
    // Remaining lines if one file is longer
    for (let i = maxLines; i < m && result.length < MAX_DIFF_LINES; i++) {
      result.push({ kind: "-", text: linesA[i]!, lineNumber: i + 1 });
    }
    for (let i = maxLines; i < n && result.length < MAX_DIFF_LINES; i++) {
      result.push({ kind: "+", text: linesB[i]!, lineNumber: i + 1 });
    }
    return result;
  }

  // LCS DP table
  const dp: number[][] = Array.from({ length: maxLen + 1 }, () =>
    new Array(maxLenB + 1).fill(0),
  );

  for (let i = 1; i <= maxLen; i++) {
    for (let j = 1; j <= maxLenB; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce diff
  const diffLines: DiffLine[] = [];
  let i = maxLen;
  let j = maxLenB;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      // context line (present in both)
      diffLines.push({ kind: " ", text: linesA[i - 1]!, lineNumber: i });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      // added line (only in B)
      diffLines.push({ kind: "+", text: linesB[j - 1]!, lineNumber: j });
      j--;
    } else if (i > 0) {
      // removed line (only in A)
      diffLines.push({ kind: "-", text: linesA[i - 1]!, lineNumber: i });
      i--;
    }
  }

  diffLines.reverse();

  // Cap output size
  return diffLines.slice(0, MAX_DIFF_LINES);
}

function buildSummary(c: PromptComparison): string {
  const lines: string[] = [];
  lines.push(`Identical: ${c.identical}`);
  lines.push(`Size A: ${c.sizeA} B: ${c.sizeB} (delta: ${c.sizeDelta >= 0 ? "+" : ""}${c.sizeDelta})`);
  lines.push(
    `Tokens A: ${c.estimatedTokensA} B: ${c.estimatedTokensB} (delta: ${c.tokenDelta >= 0 ? "+" : ""}${c.tokenDelta})`,
  );
  if (c.error) {
    lines.push(`Error: ${c.error}`);
  }
  if (!c.identical && !c.error) {
    const added = c.diffLines.filter((l) => l.kind === "+").length;
    const removed = c.diffLines.filter((l) => l.kind === "-").length;
    lines.push(`Diff lines: +${added} -${removed} (${c.diffLines.length} total shown)`);
  }
  return lines.join("\n");
}

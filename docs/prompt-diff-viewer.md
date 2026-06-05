# Prompt Diff Viewer

Helper domain for listing and comparing `promptRef` artifacts without loading
large prompt content into model context or TUI loop frame detail panes.

## Purpose

The harness writes large FIM prompts to `debug/prompts/` step artifacts and
references them via `promptRef` / `traceRef` in transcript events. The TUI
shows these as path references only — by design, to avoid dumping large
prompts into loop detail or model context.

This module provides pure domain functions so an operator or future agent can:

1. List available `promptRef` artifacts across steps of a run
2. Select two artifacts and compare them side-by-side (line diff, sizes, token counts)
3. Get structured comparison output suitable for TUI display — without loading
   full prompt content into the model context or TUI loop frame detail panes

## Non-Goals

- No model-visible tool changes
- No TUI renderer changes (view-model-level domain helper only)
- No CLI subcommand (building block for future CLI or TUI integration)
- No writing to transcript or model context
- No implicit filesystem scanning (caller provides explicit paths)

## Data Sources

The module reads from the run-scoped `debug/prompts/` directory:

```
.tiny-agent/runs/<runId>/debug/prompts/
  step-0000-thinking.prompt.txt
  step-0001-thinking.prompt.txt
  ...
```

Each file is a full FIM prompt written during `model_requested` processing.
The `promptRef.relativePath` in transcript decision events points to these files.

## API Shape

Located at `src/tui/prompt-diff-viewer.ts`:

```ts
// List prompt artifacts in a run's debug/prompts directory
function listPromptArtifacts(runDir: string): PromptArtifactEntry[]

// Compare two prompt artifact files
function comparePromptArtifacts(pathA: string, pathB: string): PromptComparison

// Simple character/4 token estimation
function estimateTokenCount(text: string): number
```

### PromptArtifactEntry

```ts
type PromptArtifactEntry = {
  step: number;           // parsed from "step-NNNN-" prefix, -1 if unparseable
  fileName: string;       // original filename, not full path
  relativePath: string;   // relative to run directory
  fileSize: number;       // bytes
  estimatedTokens: number; // characters / 4, rounded up
};
```

### PromptComparison

```ts
type PromptComparison = {
  identical: boolean;
  sizeA: number;
  sizeB: number;
  sizeDelta: number;       // sizeA - sizeB
  estimatedTokensA: number;
  estimatedTokensB: number;
  tokenDelta: number;      // estimatedTokensA - estimatedTokensB
  diffLines: DiffLine[];   // line-level diff, max 500 lines
  summary?: string;        // human-readable summary
  error?: string;          // set on file-not-found or read error
};

type DiffLine = {
  kind: "+" | "-" | " ";  // added, removed, context
  text: string;            // line text without trailing newline
  lineNumber: number;      // 1-based, in file A (removed/context) or B (added/context)
};
```

## How TUI/CLI Consumes It

This module is a building block. Future integrations may:

- **TUI detail pane**: `ViewModelBuilder` or `debugger.ts` can call
  `listPromptArtifacts(runDir)` to populate a "Prompt Artifacts" section,
  and `comparePromptArtifacts(pathA, pathB)` to generate a diff display
  when the user selects two artifacts.

- **CLI command**: A `tiny-agent prompt-diff --run <id> --a step-0000 --b step-0005`
  subcommand could use these helpers and write output to stdout or a file.

- **Environment reminder**: If an agent asks to compare two promptRefs,
  the orchestrator can route the question to this helper and return the
  comparison summary as an observation, without loading raw prompt text
  into the model context.

## Boundaries

1. **No model-context injection**: Comparison output stays in session log
   or TUI display. It is never injected as raw content into model context
   or loop frame detail panes.

2. **No TUI renderer changes in this slice**: The helpers are pure domain
   functions. TUI integration is a separate, future step.

3. **Chunked reading**: `listPromptArtifacts` reads at most 64KB per file
   for token estimation. `comparePromptArtifacts` reads both files fully
   (since diffing requires complete content) but caps diff output at 500
   lines.

4. **Simple token heuristic**: Uses `ceil(chars / 4)`. Exact tokenization
   is out of scope for this helper. The heuristic is consistent and
   sufficient for comparison purposes.

5. **LCS diff with bounds**: The line diff uses a longest-common-subsequence
   algorithm capped at 5000×5000 lines for performance. Larger files fall
   back to simple line-by-line comparison. Cross-chunk matches may be missed
   for very large files; this is documented but acceptable for prompt
   comparison use cases.

## Test Coverage

`tests/prompt-diff-viewer.test.ts` covers:

- Listing artifacts: empty dir, missing dir, sorted by step, non-numeric steps
- Comparing artifacts: identical, added/removed lines, missing files, empty
  files, large files, summary output
- Token estimation: empty string, char/4 heuristic, rounding

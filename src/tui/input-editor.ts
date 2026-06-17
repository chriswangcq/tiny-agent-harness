export type TuiInputEditorState = {
  buffer: string;
};

export type TuiInputEditorAction =
  | { kind: "insert-text"; text: string }
  | { kind: "insert-newline" }
  | { kind: "backspace" }
  | { kind: "submit" }
  | { kind: "clear" };

export type TuiInputEditorResult = {
  state: TuiInputEditorState;
  submittedText?: string;
};

export type TuiInputEditorDeps = {
  graphemeClusters: (text: string) => string[];
};

export function createTuiInputEditorState(buffer = ""): TuiInputEditorState {
  return { buffer };
}

export function reduceTuiInputEditor(
  state: TuiInputEditorState,
  action: TuiInputEditorAction,
  deps: TuiInputEditorDeps = DEFAULT_INPUT_EDITOR_DEPS,
): TuiInputEditorResult {
  switch (action.kind) {
    case "insert-text":
      if (action.text.length === 0) {
        return { state };
      }
      return { state: { buffer: `${state.buffer}${action.text}` } };
    case "insert-newline":
      return { state: { buffer: `${state.buffer}\n` } };
    case "backspace": {
      const clusters = deps.graphemeClusters(state.buffer);
      clusters.pop();
      return { state: { buffer: clusters.join("") } };
    }
    case "clear":
      return { state: { buffer: "" } };
    case "submit": {
      const submittedText = state.buffer.trimEnd();
      const next = { buffer: "" };
      return submittedText.trim().length === 0
        ? { state: next }
        : { state: next, submittedText };
    }
  }
}

const DEFAULT_INPUT_EDITOR_DEPS: TuiInputEditorDeps = {
  graphemeClusters: defaultGraphemeClusters,
};

type GraphemeSegment = { segment: string };

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

const graphemeSegmenter = (() => {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale: string | undefined,
        options: { granularity: "grapheme" },
      ) => GraphemeSegmenter;
    }
  ).Segmenter;
  return Segmenter
    ? new Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
})();

function defaultGraphemeClusters(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

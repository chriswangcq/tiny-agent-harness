export type StreamTagMode = string;

export type StreamTagDefinition = {
  id: string;
  tag: string;
  modes?: StreamTagMode[];
  action?: StreamTagAction;
};

export type StreamTagEvent =
  | {
      type: "text";
      text: string;
      mode: StreamTagMode;
    }
  | {
      type: "tag";
      id: string;
      tag: string;
      mode: StreamTagMode;
    }
  | {
      type: "mode_switched";
      from: StreamTagMode;
      to: StreamTagMode;
      tagId: string;
    }
  | {
      type: "paused";
      tagId: string;
      mode: StreamTagMode;
    };

export type StreamTagActionContext = {
  readonly mode: StreamTagMode;
  switchMode(mode: StreamTagMode): void;
  emit(event: StreamTagEvent): void;
  pause(): void;
};

export type StreamTagActionDirective =
  | { kind: "continue" }
  | { kind: "switch_mode"; mode: StreamTagMode }
  | { kind: "pause" };

export type StreamTagActionResult = void | StreamTagActionDirective;

export type StreamTagAction = (
  event: Extract<StreamTagEvent, { type: "tag" }>,
  context: StreamTagActionContext,
) => StreamTagActionResult;

export type StreamTextHandler = (
  event: Extract<StreamTagEvent, { type: "text" }>,
) => void;

export type StreamTagRouterOptions = {
  initialMode?: StreamTagMode;
  tags: StreamTagDefinition[];
  onText?: StreamTextHandler;
};

export type StreamTagFeedResult = {
  events: StreamTagEvent[];
  consumed: number;
  unconsumed: string;
  mode: StreamTagMode;
  paused: boolean;
};

type AhoNode = {
  next: Map<string, number>;
  fail: number;
  outputs: string[];
};

type StreamTagDefinitionWithOrder = StreamTagDefinition & {
  order: number;
};

export class StreamTagRouter {
  private readonly definitions: StreamTagDefinitionWithOrder[];
  private readonly automaton: AhoCorasickMatcher;
  private readonly onText: StreamTextHandler | undefined;
  private mode: StreamTagMode;
  private pending = "";
  private state = 0;
  private paused = false;

  constructor(options: StreamTagRouterOptions) {
    if (options.tags.length === 0) {
      throw new Error("StreamTagRouter requires at least one tag.");
    }
    for (const tag of options.tags) {
      if (tag.tag.length === 0) {
        throw new Error(`StreamTagRouter tag "${tag.id}" must not be empty.`);
      }
    }
    this.definitions = options.tags.map((tag, order) => ({ ...tag, order }));
    this.automaton = new AhoCorasickMatcher([
      ...new Set(this.definitions.map((definition) => definition.tag)),
    ]);
    this.onText = options.onText;
    this.mode = options.initialMode ?? "default";
  }

  feed(chunk: string): StreamTagFeedResult {
    if (this.paused) {
      throw new Error("Cannot feed StreamTagRouter while it is paused.");
    }

    const events: StreamTagEvent[] = [];
    const chars = Array.from(chunk);
    for (let index = 0; index < chars.length; index++) {
      const ch = chars[index]!;
      this.pending += ch;
      this.state = this.automaton.step(this.state, ch);

      const match = this.selectActiveMatch(this.automaton.outputs(this.state));
      // Let a longer active tag win before firing a shorter overlapping tag.
      if (match && !this.hasLongerActivePrefix(this.pending)) {
        const textBeforeTag = this.pending.slice(0, -match.tag.length);
        this.emitText(textBeforeTag, events);
        this.pending = "";
        this.state = 0;

        const tagEvent: Extract<StreamTagEvent, { type: "tag" }> = {
          type: "tag",
          id: match.id,
          tag: match.tag,
          mode: this.mode,
        };
        events.push(tagEvent);
        this.runTagAction(match, tagEvent, events);

        if (this.paused) {
          const unconsumed = chars.slice(index + 1).join("");
          return {
            events,
            consumed: chunk.length - unconsumed.length,
            unconsumed,
            mode: this.mode,
            paused: true,
          };
        }
        continue;
      }

      const keep = this.longestActivePrefixSuffixLength(this.pending);
      const flushLength = this.pending.length - keep;
      if (flushLength > 0) {
        const safeText = this.pending.slice(0, flushLength);
        this.pending = this.pending.slice(flushLength);
        this.state = this.automaton.replay(this.pending);
        this.emitText(safeText, events);
      }
    }

    return {
      events,
      consumed: chunk.length,
      unconsumed: "",
      mode: this.mode,
      paused: this.paused,
    };
  }

  flush(): StreamTagEvent[] {
    if (this.paused) {
      throw new Error("Cannot flush StreamTagRouter while it is paused.");
    }
    const events: StreamTagEvent[] = [];
    this.emitText(this.pending, events);
    this.pending = "";
    this.state = 0;
    return events;
  }

  resume(): void {
    this.paused = false;
  }

  currentMode(): StreamTagMode {
    return this.mode;
  }

  pendingCandidate(): string {
    return this.pending;
  }

  candidateTags(): string[] {
    if (this.pending.length === 0) return [];
    return this.activeTags().filter((tag) => tag.startsWith(this.pending));
  }

  private runTagAction(
    definition: StreamTagDefinitionWithOrder,
    event: Extract<StreamTagEvent, { type: "tag" }>,
    events: StreamTagEvent[],
  ): void {
    const router = this;
    const context: StreamTagActionContext = {
      get mode() {
        return router.mode;
      },
      switchMode: (mode) => {
        this.switchMode(mode, definition.id, events);
      },
      emit: (customEvent) => {
        events.push(customEvent);
      },
      pause: () => {
        this.pause(definition.id, events);
      },
    };

    const result = definition.action?.(event, context);
    if (isPromiseLike(result)) {
      throw new Error(
        `StreamTagRouter action "${definition.id}" returned a Promise; tag actions must synchronously block parsing or return { kind: "pause" }.`,
      );
    }

    if (!result || result.kind === "continue") return;
    if (result.kind === "switch_mode") {
      this.switchMode(result.mode, definition.id, events);
      return;
    }
    if (result.kind === "pause") {
      this.pause(definition.id, events);
    }
  }

  private switchMode(
    mode: StreamTagMode,
    tagId: string,
    events: StreamTagEvent[],
  ): void {
    if (mode === this.mode) return;
    const from = this.mode;
    this.mode = mode;
    events.push({ type: "mode_switched", from, to: mode, tagId });
  }

  private emitText(text: string, events: StreamTagEvent[]): void {
    if (text.length === 0) return;
    const event: Extract<StreamTagEvent, { type: "text" }> = {
      type: "text",
      text,
      mode: this.mode,
    };
    const last = events.at(-1);
    if (last?.type === "text" && last.mode === event.mode) {
      last.text += event.text;
    } else {
      events.push(event);
    }
    const result = this.onText?.(event);
    if (isPromiseLike(result)) {
      throw new Error("StreamTagRouter onText handler must be synchronous.");
    }
  }

  private selectActiveMatch(tags: string[]): StreamTagDefinitionWithOrder | undefined {
    const matches = tags.flatMap((tag) =>
      this.definitions.filter(
        (definition) =>
          definition.tag === tag && this.isDefinitionActive(definition),
      ),
    );
    return matches.sort(
      (a, b) => b.tag.length - a.tag.length || a.order - b.order,
    )[0];
  }

  private longestActivePrefixSuffixLength(text: string): number {
    const tags = this.activeTags();
    const maxLength = Math.min(
      text.length,
      Math.max(0, ...tags.map((tag) => tag.length - 1)),
    );
    for (let length = maxLength; length > 0; length--) {
      const suffix = text.slice(-length);
      if (tags.some((tag) => tag.startsWith(suffix))) return length;
    }
    return 0;
  }

  private activeTags(): string[] {
    return [
      ...new Set(
        this.definitions
          .filter((definition) => this.isDefinitionActive(definition))
          .map((definition) => definition.tag),
      ),
    ];
  }

  private isDefinitionActive(definition: StreamTagDefinition): boolean {
    return !definition.modes || definition.modes.includes(this.mode);
  }

  private hasLongerActivePrefix(text: string): boolean {
    return this.activeTags().some(
      (tag) => tag.length > text.length && tag.startsWith(text),
    );
  }

  private pause(tagId: string, events: StreamTagEvent[]): void {
    if (this.paused) return;
    this.paused = true;
    events.push({ type: "paused", tagId, mode: this.mode });
  }
}

class AhoCorasickMatcher {
  private readonly nodes: AhoNode[] = [{ next: new Map(), fail: 0, outputs: [] }];

  constructor(patterns: string[]) {
    for (const pattern of patterns) {
      this.add(pattern);
    }
    this.buildFailures();
  }

  step(state: number, ch: string): number {
    let current = state;
    while (current !== 0 && !this.nodes[current]!.next.has(ch)) {
      current = this.nodes[current]!.fail;
    }
    return this.nodes[current]!.next.get(ch) ?? 0;
  }

  replay(text: string): number {
    let state = 0;
    for (const ch of Array.from(text)) {
      state = this.step(state, ch);
    }
    return state;
  }

  outputs(state: number): string[] {
    return this.nodes[state]?.outputs ?? [];
  }

  private add(pattern: string): void {
    let state = 0;
    for (const ch of Array.from(pattern)) {
      const next = this.nodes[state]!.next.get(ch);
      if (next !== undefined) {
        state = next;
        continue;
      }
      const created = this.nodes.length;
      this.nodes[state]!.next.set(ch, created);
      this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
      state = created;
    }
    this.nodes[state]!.outputs.push(pattern);
  }

  private buildFailures(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) {
      this.nodes[child]!.fail = 0;
      queue.push(child);
    }

    for (let index = 0; index < queue.length; index++) {
      const state = queue[index]!;
      for (const [ch, target] of this.nodes[state]!.next) {
        let fallback = this.nodes[state]!.fail;
        while (fallback !== 0 && !this.nodes[fallback]!.next.has(ch)) {
          fallback = this.nodes[fallback]!.fail;
        }
        this.nodes[target]!.fail = this.nodes[fallback]!.next.get(ch) ?? 0;
        this.nodes[target]!.outputs.push(
          ...this.nodes[this.nodes[target]!.fail]!.outputs,
        );
        queue.push(target);
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

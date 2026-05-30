import { describe, expect, it } from "vitest";
import {
  createDsmlStreamTagDefinitions,
  StreamTagRouter,
  type StreamTagDefinition,
} from "../src/streaming/index.js";

function tag(
  id: string,
  value: string,
  modes?: string[],
  action?: StreamTagDefinition["action"],
): StreamTagDefinition {
  return { id, tag: value, modes, action };
}

describe("StreamTagRouter", () => {
  it("holds a possible tag prefix across chunks", () => {
    const router = new StreamTagRouter({
      initialMode: "text",
      tags: [tag("open", "<tag>")],
    });

    const first = router.feed("hello <ta");
    expect(first.events).toEqual([
      { type: "text", text: "hello ", mode: "text" },
    ]);
    expect(router.pendingCandidate()).toBe("<ta");
    expect(router.candidateTags()).toEqual(["<tag>"]);

    const second = router.feed("g>world");
    expect(second.events).toEqual([
      { type: "tag", id: "open", tag: "<tag>", mode: "text" },
      { type: "text", text: "world", mode: "text" },
    ]);
  });

  it("releases a cached prefix once it cannot match any active tag", () => {
    const router = new StreamTagRouter({
      initialMode: "text",
      tags: [tag("open", "<tag>")],
    });

    const result = router.feed("x <tax");

    expect(result.events).toEqual([
      { type: "text", text: "x <tax", mode: "text" },
    ]);
    expect(router.pendingCandidate()).toBe("");
  });

  it("runs tag actions synchronously before parsing later text", () => {
    const router = new StreamTagRouter({
      initialMode: "text",
      tags: [
        tag("open", "<x>", ["text"], () => ({ kind: "switch_mode", mode: "x" })),
        tag("close", "</x>", ["x"], () => ({
          kind: "switch_mode",
          mode: "text",
        })),
      ],
    });

    const result = router.feed("a<x>inside</x>b");

    expect(result.events).toEqual([
      { type: "text", text: "a", mode: "text" },
      { type: "tag", id: "open", tag: "<x>", mode: "text" },
      { type: "mode_switched", from: "text", to: "x", tagId: "open" },
      { type: "text", text: "inside", mode: "x" },
      { type: "tag", id: "close", tag: "</x>", mode: "x" },
      { type: "mode_switched", from: "x", to: "text", tagId: "close" },
      { type: "text", text: "b", mode: "text" },
    ]);
  });

  it("pauses before consuming remaining characters in the same chunk", () => {
    const router = new StreamTagRouter({
      initialMode: "text",
      tags: [tag("pause", "<pause>", ["text"], () => ({ kind: "pause" }))],
    });

    const result = router.feed("a<pause>tail");

    expect(result.paused).toBe(true);
    expect(result.unconsumed).toBe("tail");
    expect(result.events).toEqual([
      { type: "text", text: "a", mode: "text" },
      { type: "tag", id: "pause", tag: "<pause>", mode: "text" },
      { type: "paused", tagId: "pause", mode: "text" },
    ]);

    router.resume();
    expect(router.feed(result.unconsumed).events).toEqual([
      { type: "text", text: "tail", mode: "text" },
    ]);
  });

  it("lets actions inspect the current mode after a context switch", () => {
    const observedModes: string[] = [];
    const router = new StreamTagRouter({
      initialMode: "text",
      tags: [
        tag("open", "<x>", ["text"], (_event, context) => {
          context.switchMode("x");
          observedModes.push(context.mode);
        }),
      ],
    });

    router.feed("<x>");

    expect(observedModes).toEqual(["x"]);
    expect(router.currentMode()).toBe("x");
  });

  it("rejects async tag actions so parsing order stays deterministic", () => {
    const router = new StreamTagRouter({
      initialMode: "text",
      tags: [
        tag("async", "<async>", ["text"], (() =>
          Promise.resolve()) as unknown as StreamTagDefinition["action"]),
      ],
    });

    expect(() => router.feed("<async>")).toThrow(/must synchronously block/);
  });

  it("registers current DSML tags and allows action placeholders", () => {
    const seen: string[] = [];
    const router = new StreamTagRouter({
      initialMode: "thinking",
      tags: createDsmlStreamTagDefinitions({
        "dsml.tool_calls.open": (event) => {
          seen.push(event.id);
          return { kind: "switch_mode", mode: "tool_calls" };
        },
        "dsml.invoke.open_prefix": (event) => {
          seen.push(event.id);
          return { kind: "switch_mode", mode: "invoke" };
        },
      }),
    });

    const first = router.feed("thought<｜DS");
    expect(first.events).toEqual([
      { type: "text", text: "thought", mode: "thinking" },
    ]);

    const second = router.feed("ML｜tool_calls><｜DSML｜invoke name=\"");
    expect(seen).toEqual(["dsml.tool_calls.open", "dsml.invoke.open_prefix"]);
    expect(second.events).toContainEqual({
      type: "tag",
      id: "dsml.tool_calls.open",
      tag: "<｜DSML｜tool_calls>",
      mode: "thinking",
    });
    expect(second.events).toContainEqual({
      type: "mode_switched",
      from: "tool_calls",
      to: "invoke",
      tagId: "dsml.invoke.open_prefix",
    });
  });

  it("waits for a longer active tag before firing an overlapping short tag", () => {
    const seen: string[] = [];
    const router = new StreamTagRouter({
      initialMode: "thinking",
      tags: createDsmlStreamTagDefinitions({
        "dsml.tool_calls.open": (event) => {
          seen.push(event.id);
          return { kind: "switch_mode", mode: "tool_calls" };
        },
        "legacy.tool_marker": (event) => {
          seen.push(event.id);
        },
      }),
    });

    const first = router.feed("<｜DSML｜tool");
    expect(first.events).toEqual([]);
    expect(router.pendingCandidate()).toBe("<｜DSML｜tool");

    const second = router.feed("_calls>");
    expect(seen).toEqual(["dsml.tool_calls.open"]);
    expect(second.events).toContainEqual({
      type: "tag",
      id: "dsml.tool_calls.open",
      tag: "<｜DSML｜tool_calls>",
      mode: "thinking",
    });
  });
});

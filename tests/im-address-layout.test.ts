import { describe, expect, it } from "vitest";
import {
  createImConsumerAddress,
  createImDirectionalChannelAddress,
  createImPairAddress,
  normalizeImEndpoint,
  planImChannelLayout,
  planImCursorLayout,
  planImEndpointLayout,
  planImPairLayout,
  planImRootLayout,
  planImRunBindingLayout,
} from "../src/im/index.js";

describe("IM address primitives", () => {
  it("normalizes endpoint kind and slash-collapsed path", () => {
    expect(normalizeImEndpoint(" Member:team-p6//coder-1/ ")).toEqual({
      kind: "member",
      path: "team-p6/coder-1",
      canonical: "member:team-p6/coder-1",
    });
  });

  it("rejects malformed endpoints", () => {
    expect(() => normalizeImEndpoint("member")).toThrow(/Expected <kind>:<path>/);
    expect(() => normalizeImEndpoint("member:bad path")).toThrow(/Invalid IM endpoint path/);
    expect(() => normalizeImEndpoint("member:/")).toThrow(/Invalid IM endpoint path/);
  });

  it("creates order-independent pair ids", () => {
    const left = createImPairAddress("user:main", "member:team-p6/coder-1");
    const right = createImPairAddress("member:team-p6/coder-1", "user:main");

    expect(left.pairId).toBe(right.pairId);
    expect(left.pairKey).toBe(
      "im-pair.v1|member:team-p6/coder-1|user:main",
    );
  });

  it("creates directional channel ids", () => {
    const outbound = createImDirectionalChannelAddress(
      "user:main",
      "member:team-p6/coder-1",
    );
    const inbound = createImDirectionalChannelAddress(
      "member:team-p6/coder-1",
      "user:main",
    );

    expect(outbound.channelId).not.toBe(inbound.channelId);
    expect(outbound.channelKey).toBe(
      "im-channel.v1|user:main=>member:team-p6/coder-1",
    );
  });

  it("creates stable consumer ids from canonical endpoints", () => {
    const a = createImConsumerAddress("Member:team-p6//coder-1");
    const b = createImConsumerAddress("member:team-p6/coder-1");
    expect(a.consumerId).toBe(b.consumerId);
    expect(a.consumerKey).toBe("im-consumer.v1|member:team-p6/coder-1");
  });
});

describe("IM layout primitives", () => {
  it("plans project-scoped root directories", () => {
    expect(planImRootLayout("/state")).toEqual({
      imDir: "/state/im",
      endpointsDir: "/state/im/endpoints",
      pairsDir: "/state/im/pairs",
      channelsDir: "/state/im/channels",
      runBindingsDir: "/state/im/run-bindings",
    });
  });

  it("plans endpoint, pair, channel, cursor, and run binding paths", () => {
    const endpoint = planImEndpointLayout("/state", "member:team-p6/coder-1");
    expect(endpoint.endpointFile).toBe(`/state/im/endpoints/${endpoint.endpointId}.json`);

    const pair = planImPairLayout("/state", "member:team-p6/coder-1", "user:main");
    expect(pair.pairFile).toBe(`/state/im/pairs/${pair.pair.pairId}.json`);

    const channel = planImChannelLayout("/state", "user:main", "member:team-p6/coder-1");
    expect(channel.channelDir).toBe(`/state/im/channels/${channel.channel.channelId}`);
    expect(channel.messagesFile).toBe(`${channel.channelDir}/messages.jsonl`);
    expect(channel.metaFile).toBe(`${channel.channelDir}/meta.json`);

    const cursor = planImCursorLayout(
      "/state",
      "user:main",
      "member:team-p6/coder-1",
      "member:team-p6/coder-1",
    );
    expect(cursor.cursorFile).toBe(
      `${channel.channelDir}/cursors/${cursor.consumer.consumerId}.cursor`,
    );

    expect(planImRunBindingLayout("/state", "run-123").bindingFile).toBe(
      "/state/im/run-bindings/run-123.json",
    );
  });
});

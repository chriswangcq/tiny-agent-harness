import * as path from "node:path";
import type {
  ImConsumerAddress,
  ImDirectionalChannelAddress,
  ImEndpoint,
  ImPairAddress,
} from "./address.js";
import {
  createImConsumerAddress,
  createImDirectionalChannelAddress,
  createImPairAddress,
  normalizeImEndpoint,
} from "./address.js";

export type ImRootLayout = {
  imDir: string;
  endpointsDir: string;
  pairsDir: string;
  channelsDir: string;
  runBindingsDir: string;
};

export type ImEndpointLayout = ImRootLayout & {
  endpoint: ImEndpoint;
  endpointId: string;
  endpointFile: string;
};

export type ImPairLayout = ImRootLayout & {
  pair: ImPairAddress;
  pairFile: string;
};

export type ImChannelLayout = ImRootLayout & {
  channel: ImDirectionalChannelAddress;
  channelDir: string;
  metaFile: string;
  messagesFile: string;
  cursorsDir: string;
};

export type ImCursorLayout = ImChannelLayout & {
  consumer: ImConsumerAddress;
  cursorFile: string;
};

export type ImRunBindingLayout = ImRootLayout & {
  runId: string;
  bindingFile: string;
};

export function planImRootLayout(stateRoot: string): ImRootLayout {
  const imDir = path.join(stateRoot, "im");
  return {
    imDir,
    endpointsDir: path.join(imDir, "endpoints"),
    pairsDir: path.join(imDir, "pairs"),
    channelsDir: path.join(imDir, "channels"),
    runBindingsDir: path.join(imDir, "run-bindings"),
  };
}

export function planImEndpointLayout(
  stateRoot: string,
  endpointInput: string | ImEndpoint,
): ImEndpointLayout {
  const root = planImRootLayout(stateRoot);
  const endpoint =
    typeof endpointInput === "string" ? normalizeImEndpoint(endpointInput) : endpointInput;
  const consumer = createImConsumerAddress(endpoint);
  return {
    ...root,
    endpoint,
    endpointId: consumer.consumerId,
    endpointFile: path.join(root.endpointsDir, `${consumer.consumerId}.json`),
  };
}

export function planImPairLayout(
  stateRoot: string,
  left: string | ImEndpoint,
  right: string | ImEndpoint,
): ImPairLayout {
  const root = planImRootLayout(stateRoot);
  const pair = createImPairAddress(left, right);
  return {
    ...root,
    pair,
    pairFile: path.join(root.pairsDir, `${pair.pairId}.json`),
  };
}

export function planImChannelLayout(
  stateRoot: string,
  from: string | ImEndpoint,
  to: string | ImEndpoint,
): ImChannelLayout {
  const root = planImRootLayout(stateRoot);
  const channel = createImDirectionalChannelAddress(from, to);
  const channelDir = path.join(root.channelsDir, channel.channelId);
  return {
    ...root,
    channel,
    channelDir,
    metaFile: path.join(channelDir, "meta.json"),
    messagesFile: path.join(channelDir, "messages.jsonl"),
    cursorsDir: path.join(channelDir, "cursors"),
  };
}

export function planImCursorLayout(
  stateRoot: string,
  from: string | ImEndpoint,
  to: string | ImEndpoint,
  consumerInput: string | ImEndpoint,
): ImCursorLayout {
  const channelLayout = planImChannelLayout(stateRoot, from, to);
  const consumer = createImConsumerAddress(consumerInput);
  return {
    ...channelLayout,
    consumer,
    cursorFile: path.join(channelLayout.cursorsDir, `${consumer.consumerId}.cursor`),
  };
}

export function planImRunBindingLayout(
  stateRoot: string,
  runId: string,
): ImRunBindingLayout {
  const root = planImRootLayout(stateRoot);
  return {
    ...root,
    runId,
    bindingFile: path.join(root.runBindingsDir, `${runId}.json`),
  };
}

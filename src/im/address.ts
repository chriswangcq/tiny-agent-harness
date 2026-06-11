import * as crypto from "node:crypto";

export type ImEndpoint = {
  kind: string;
  path: string;
  canonical: string;
};

export type ImPairAddress = {
  endpointA: ImEndpoint;
  endpointB: ImEndpoint;
  pairKey: string;
  pairId: string;
};

export type ImDirectionalChannelAddress = {
  from: ImEndpoint;
  to: ImEndpoint;
  channelKey: string;
  channelId: string;
};

export type ImConsumerAddress = {
  consumer: ImEndpoint;
  consumerKey: string;
  consumerId: string;
};

const ENDPOINT_PATTERN = /^([a-zA-Z][a-zA-Z0-9_-]*):(.+)$/;
const ENDPOINT_PATH_PATTERN = /^[A-Za-z0-9._~/-]+$/;

export function md5Hex(value: string): string {
  return crypto.createHash("md5").update(value).digest("hex");
}

export function normalizeImEndpoint(value: string): ImEndpoint {
  const trimmed = value.trim();
  const match = ENDPOINT_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid IM endpoint "${value}". Expected <kind>:<path>.`);
  }

  const kind = match[1]!.toLowerCase();
  const path = normalizeEndpointPath(match[2]!);
  const canonical = `${kind}:${path}`;
  return { kind, path, canonical };
}

export function compareImEndpoints(left: ImEndpoint, right: ImEndpoint): number {
  return left.canonical.localeCompare(right.canonical);
}

export function createImPairAddress(
  left: string | ImEndpoint,
  right: string | ImEndpoint,
): ImPairAddress {
  const endpointA = typeof left === "string" ? normalizeImEndpoint(left) : left;
  const endpointB = typeof right === "string" ? normalizeImEndpoint(right) : right;
  if (endpointA.canonical === endpointB.canonical) {
    throw new Error(`IM pair requires two distinct endpoints: ${endpointA.canonical}`);
  }

  const ordered = [endpointA, endpointB].sort(compareImEndpoints);
  const pairKey = `im-pair.v1|${ordered[0]!.canonical}|${ordered[1]!.canonical}`;
  return {
    endpointA: ordered[0]!,
    endpointB: ordered[1]!,
    pairKey,
    pairId: md5Hex(pairKey),
  };
}

export function createImDirectionalChannelAddress(
  from: string | ImEndpoint,
  to: string | ImEndpoint,
): ImDirectionalChannelAddress {
  const fromEndpoint = typeof from === "string" ? normalizeImEndpoint(from) : from;
  const toEndpoint = typeof to === "string" ? normalizeImEndpoint(to) : to;
  if (fromEndpoint.canonical === toEndpoint.canonical) {
    throw new Error(`IM channel requires two distinct endpoints: ${fromEndpoint.canonical}`);
  }

  const channelKey = `im-channel.v1|${fromEndpoint.canonical}=>${toEndpoint.canonical}`;
  return {
    from: fromEndpoint,
    to: toEndpoint,
    channelKey,
    channelId: md5Hex(channelKey),
  };
}

export function createImConsumerAddress(
  consumer: string | ImEndpoint,
): ImConsumerAddress {
  const endpoint = typeof consumer === "string" ? normalizeImEndpoint(consumer) : consumer;
  const consumerKey = `im-consumer.v1|${endpoint.canonical}`;
  return {
    consumer: endpoint,
    consumerKey,
    consumerId: md5Hex(consumerKey),
  };
}

function normalizeEndpointPath(value: string): string {
  const collapsed = value.trim().replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  if (!collapsed || !ENDPOINT_PATH_PATTERN.test(collapsed)) {
    throw new Error(`Invalid IM endpoint path "${value}".`);
  }
  return collapsed;
}

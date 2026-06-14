import { expect, test } from "bun:test";
import { z } from "zod";
import {
  formatKeySegment,
  formatSegment,
  isDescendantPathKey,
  KEY_SEGMENT_MAX_LEN,
} from "./format";
import { edge } from "./decorators";
import { createMockTransportPair, type Transport } from "./protocol";
import { createSerializer } from "./serialization";
import { createServer } from "./server";
import { flush, type WireMessage } from "./test-utils";
import { Node } from "./types";

const serializer = createSerializer();

// -- formatKeySegment: bounded keys without collisions --

test("formatKeySegment is identical to formatSegment for normal-sized segments", () => {
  const seg: ["get", string] = ["get", "42"];
  expect(formatKeySegment(seg)).toBe(formatSegment(seg));
});

test("formatKeySegment bounds the output length for huge arguments", () => {
  const huge = "x".repeat(5_000_000);
  const key = formatKeySegment(["get", huge]);
  // Bounded to roughly the cap plus a short hash/length suffix.
  expect(key.length).toBeLessThan(KEY_SEGMENT_MAX_LEN + 64);
});

test("formatKeySegment keeps distinct huge arguments distinct (no collision)", () => {
  const a = "a".repeat(2_000_000);
  const b = "a".repeat(1_999_999) + "b"; // same length, differs at the end
  expect(formatKeySegment(["get", a])).not.toBe(formatKeySegment(["get", b]));
  // Different lengths, identical 1024-char prefix:
  const c = "a".repeat(2_000_001);
  expect(formatKeySegment(["get", a])).not.toBe(formatKeySegment(["get", c]));
});

test("truncated key still satisfies the descendant-prefix property", () => {
  const huge = "z".repeat(2_000_000);
  const parentKey = "root" + formatKeySegment(["get", huge]);
  const childKey = parentKey + formatKeySegment("child");
  expect(isDescendantPathKey(parentKey, childKey)).toBe(true);
});

// -- maxMessageBytes: oversized frames close the connection --

class Api extends Node {
  @edge(() => Api, z.string())
  child(_id: string): Api {
    return new Api();
  }
}

test("maxMessageBytes closes the connection on an oversized frame", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  let closed = false;
  clientTransport.addEventListener("close", () => {
    closed = true;
  });
  const server = createServer(
    { idleTimeout: 0, pingInterval: 0, maxMessageBytes: 1024 },
    () => new Api(),
  );
  server.handle(serverTransport as Transport, {});
  await flush();

  // A valid edge message, but with an argument far larger than the cap.
  clientTransport.send(
    serializer.stringify({
      op: "edge",
      tok: 0,
      edge: "child",
      args: ["y".repeat(5000)],
    }),
  );
  await flush();
  expect(closed).toBe(true);
});

test("maxMessageBytes allows normal-sized frames through", async () => {
  const [serverTransport, clientTransport] = createMockTransportPair();
  const received: string[] = [];
  clientTransport.addEventListener("message", (e) => received.push(e.data));
  const server = createServer(
    { idleTimeout: 0, pingInterval: 0, maxMessageBytes: 1024 },
    () => new Api(),
  );
  server.handle(serverTransport as Transport, {});
  await flush();
  received.length = 0;

  clientTransport.send(
    serializer.stringify({ op: "edge", tok: 0, edge: "child", args: ["42"] }),
  );
  await flush();
  const msgs = received.map((r) => serializer.parse(r) as WireMessage);
  const edgeRes = msgs.find((m) => m.op === "edge");
  expect(edgeRes).toBeDefined();
  expect(edgeRes!.error).toBeUndefined();
});

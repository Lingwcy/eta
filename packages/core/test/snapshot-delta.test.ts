import { expect, test } from "vite-plus/test";
import type { SnapshotResponse } from "../src/agent/protocol.ts";
import { SnapshotDeltaDecoder, SnapshotDeltaEncoder } from "../src/shared/snapshot-delta.ts";

function snapshot(texts = ["one", "two", "three"]): SnapshotResponse {
  return {
    contextTokens: 3,
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: texts.map((content, index) => ({
        id: String(index),
        type: "message",
        message: { role: "user", content, timestamp: 0 },
      })),
      operation: null,
      lastResult: null,
      faulted: false,
    },
  };
}

test("incremental snapshots round-trip appends, replacements, deletions, reordering and optional-state removal", () => {
  const encoder = new SnapshotDeltaEncoder();
  const decoder = new SnapshotDeltaDecoder();
  const values = [
    snapshot(),
    snapshot(["one", "changed", "three"]),
    snapshot(["one", "changed", "three", "four"]),
    snapshot(["one", "four"]),
    snapshot(["four", "one"]),
    snapshot([]),
  ];
  values[0]!.snapshot.blockedReason = "unavailable";
  for (const value of values) {
    const encoded = encoder.encode(value);
    expect(decoder.decode(encoded.event, encoded.data)).toEqual(value);
  }
});

test("a live-only update does not resend megabytes of unchanged history", () => {
  const encoder = new SnapshotDeltaEncoder();
  const decoder = new SnapshotDeltaDecoder();
  const first = snapshot(Array.from({ length: 1000 }, (_, i) => `${i}:` + "history ".repeat(1000)));
  const full = encoder.encode(first);
  expect(full.data.length).toBeGreaterThan(8_000_000);
  decoder.decode(full.event, full.data);
  const next = { ...first, contextTokens: 4, snapshot: { ...first.snapshot, compacting: true } };
  const delta = encoder.encode(next);
  expect(delta.event).toBe("snapshot-delta");
  expect(delta.data.length).toBeLessThan(500);
  expect(decoder.decode(delta.event, delta.data)).toEqual(next);
});

test("legacy full snapshots and a reconnect establish independent baselines", () => {
  const decoder = new SnapshotDeltaDecoder();
  const old = snapshot();
  expect(decoder.decode("snapshot", JSON.stringify(old))).toEqual(old);
  expect(decoder.decode("snapshot", JSON.stringify(snapshot(["legacy update"])))).toEqual(
    snapshot(["legacy update"]),
  );
  decoder.reset();
  const encoder = new SnapshotDeltaEncoder();
  for (const value of [snapshot(["new server"]), snapshot(["new server", "next"])]) {
    const frame = encoder.encode(value);
    expect(decoder.decode(frame.event, frame.data)).toEqual(value);
  }
});

test.each(["no-base", "gap", "duplicate", "negative", "overlap", "fraction"])(
  "%s delta rejects without corrupting the current history",
  (kind) => {
    const encoder = new SnapshotDeltaEncoder();
    const decoder = new SnapshotDeltaDecoder();
    const first = encoder.encode(snapshot());
    if (kind !== "no-base") decoder.decode(first.event, first.data);
    const frame = encoder.encode(snapshot(["new"]));
    const delta = JSON.parse(frame.data);
    if (kind === "gap") delta.base = 3;
    if (kind === "negative") delta.transcript.prefix = -1;
    if (kind === "overlap") {
      delta.transcript.prefix = 3;
      delta.transcript.suffix = 1;
    }
    if (kind === "fraction") delta.transcript.prefix = 0.5;
    if (kind === "duplicate") decoder.decode(frame.event, frame.data);
    expect(() => decoder.decode(frame.event, JSON.stringify(delta))).toThrow("sequence");
    const replacement = new SnapshotDeltaEncoder().encode(snapshot(["recovered"]));
    expect(decoder.decode(replacement.event, replacement.data)).toEqual(snapshot(["recovered"]));
  },
);

# Bot incremental observations

Tracked in [#402](https://github.com/Lingwcy/eta/issues/402). This opt-in display protocol does not change durable Core history.

Clients request `x-eta-snapshot: delta-v1` on thread SSE. Missing or unknown values retain the full `snapshot` feed. Thus old Desktop/new Bot remains unchanged; new Desktop/old Bot accepts the old full feed when its header is ignored. Reverting either transport endpoint is safe without migrating stored data.

Each connection begins with `event: snapshot`, whose data is the existing `SnapshotResponse`. This establishes revision zero. Subsequent `event: snapshot-delta` data has this shape:

```ts
{
  version: 1,
  base: number,
  revision: number,
  contextTokens: number,
  snapshot: Omit<AgentSnapshot, "transcript">,
  transcript: { prefix: number, suffix: number, insert: TranscriptEntry[] }
}
```

`base` must equal the last accepted revision and `revision` must be `base + 1`. Keep `prefix` entries from the old transcript's start and `suffix` from its end, inserting the supplied entries between them. Counts must be nonnegative safe integers and cannot overlap. The non-transcript snapshot is replaced in full so removed optional state is cleared. Entry equality includes content, not just IDs: historical corrections and removals must survive.

A missing baseline, invalid splice or sequence gap rejects the frame without publishing it. The adapter cancels that SSE attempt, discards decoder state and reconnects for a full baseline. Remaining frames from the failed attempt cannot be delivered. Cached UI history can remain readable but does not establish a live connection. A reconnect never reuses the previous connection's revision sequence.

The codec is independent of transport activation and can land or roll back separately. See [codec and boundary tests](../../packages/core/test/snapshot-delta.test.ts). The first baseline remains full-size; encoding still compares history and does not eliminate Core's projection work. Wire-size measurements must distinguish uncompressed JSON, gzip bytes and framing.

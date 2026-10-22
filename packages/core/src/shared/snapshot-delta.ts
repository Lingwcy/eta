import type { AgentSnapshot, SnapshotResponse } from "../agent/protocol.ts";

type Transcript = AgentSnapshot["transcript"];

export interface SnapshotDelta {
  version: 1;
  base: number;
  revision: number;
  contextTokens: number;
  snapshot: Omit<AgentSnapshot, "transcript">;
  transcript: { prefix: number; suffix: number; insert: Transcript };
}

/** Each SSE connection starts with a full snapshot, then replaces only changed transcript entries. */
export class SnapshotDeltaEncoder {
  private previous?: string[];
  private revision = 0;

  encode(value: SnapshotResponse) {
    const { transcript, ...snapshot } = value.snapshot;
    const serialized = transcript.map((entry) => JSON.stringify(entry));
    const previous = this.previous;
    this.previous = serialized;
    if (!previous) return { event: "snapshot", data: JSON.stringify(value) };
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < serialized.length &&
      previous[prefix] === serialized[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < serialized.length - prefix &&
      previous[previous.length - suffix - 1] === serialized[serialized.length - suffix - 1]
    )
      suffix++;
    const delta: SnapshotDelta = {
      version: 1,
      base: this.revision,
      revision: ++this.revision,
      contextTokens: value.contextTokens,
      snapshot,
      transcript: { prefix, suffix, insert: transcript.slice(prefix, transcript.length - suffix) },
    };
    return { event: "snapshot-delta", data: JSON.stringify(delta) };
  }
}

/** A missing base or sequence gap must reconnect for a full snapshot instead of guessing at history. */
export class SnapshotDeltaDecoder {
  private value?: SnapshotResponse;
  private revision = 0;

  reset() {
    this.value = undefined;
    this.revision = 0;
  }

  decode(event: string | undefined, data: string): SnapshotResponse | undefined {
    if (event === "snapshot") {
      this.value = JSON.parse(data) as SnapshotResponse;
      this.revision = 0;
      return this.value;
    }
    if (event !== "snapshot-delta") return;
    const delta = JSON.parse(data) as SnapshotDelta;
    const previous = this.value?.snapshot.transcript;
    const change = delta.transcript;
    if (
      !previous ||
      delta.version !== 1 ||
      delta.base !== this.revision ||
      delta.revision !== this.revision + 1 ||
      !change ||
      !Number.isSafeInteger(change.prefix) ||
      !Number.isSafeInteger(change.suffix) ||
      change.prefix < 0 ||
      change.suffix < 0 ||
      change.prefix + change.suffix > previous.length ||
      !Array.isArray(change.insert)
    )
      throw new Error("Bot snapshot sequence is incomplete; reconnecting.");
    this.value = {
      contextTokens: delta.contextTokens,
      snapshot: {
        ...delta.snapshot,
        transcript: [
          ...previous.slice(0, change.prefix),
          ...change.insert,
          ...previous.slice(previous.length - change.suffix),
        ],
      },
    };
    this.revision = delta.revision;
    return this.value;
  }
}

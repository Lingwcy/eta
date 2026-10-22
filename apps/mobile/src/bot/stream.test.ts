import { expect, test } from "vite-plus/test";
import { readEvents } from "./stream.ts";

test("SSE parses UTF-8, split CRLF, multiple data lines and ignores comments", async () => {
  const input = new TextEncoder().encode(
    ": heartbeat\r\nevent: snapshot\r\ndata: 你好\r\ndata: 第二行\r\n\r\nevent: error\ndata: failure\n\n",
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of input) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const received: { event: string; data: string }[] = [];
  await readEvents(body, (event) => received.push(event), new AbortController().signal);
  expect(received).toEqual([
    { event: "snapshot", data: "你好\n第二行" },
    { event: "error", data: "failure" },
  ]);
});

test.each(["\n", "\r\n", "\r"])(
  "SSE preserves frames at every byte split with %j line endings",
  async (ending) => {
    const bytes = new TextEncoder().encode(
      [
        ": comment",
        "event: snapshot",
        "data: 你好",
        "data: 第二行",
        "",
        "event: heartbeat",
        "data: {}",
        "",
        "event: incomplete",
        "data: ignored",
      ].join(ending),
    );
    for (let split = 0; split <= bytes.length; split++) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, split));
          controller.enqueue(new Uint8Array());
          controller.enqueue(bytes.subarray(split));
          controller.close();
        },
      });
      const received: { event: string; data: string }[] = [];
      await readEvents(body, (event) => received.push(event), new AbortController().signal);
      expect(received).toEqual([
        { event: "snapshot", data: "你好\n第二行" },
        { event: "heartbeat", data: "{}" },
      ]);
    }
  },
);

test.each(["line", "frame"])("oversized %s is rejected and releases the stream", async (kind) => {
  const payload = "x".repeat(1024 * 1024);
  const chunk = new TextEncoder().encode(kind === "line" ? payload : "data: " + payload + "\n");
  let chunks = 0;
  let cancelled = false;
  let deliveries = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ === 70) return controller.close();
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readEvents(body, () => deliveries++, new AbortController().signal)).rejects.toThrow(
    "Bot 实时消息过大",
  );
  expect(deliveries).toBe(0);
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("a fragmented large data line scans only newly received text", async () => {
  const data = JSON.stringify({ text: "x".repeat(1024 * 1024) });
  const wire = "event: snapshot\ndata: " + data + "\n\n";
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 1024));
      offset = Math.min(bytes.length, offset + 1024);
    },
  });
  let searched = 0;
  const original = RegExp.prototype.exec;
  // Do not retain call arguments: growing-prefix histories would distort memory use.
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (this.source.includes("\\r") && this.source.includes("\\n"))
      searched += input.length - (this.global ? this.lastIndex : 0);
    return original.call(this, input);
  };
  const received: { event: string; data: string }[] = [];
  try {
    await readEvents(body, (event) => received.push(event), new AbortController().signal);
  } finally {
    RegExp.prototype.exec = original;
  }
  expect(received).toEqual([{ event: "snapshot", data }]);
  expect(searched).toBeGreaterThanOrEqual(wire.length);
  expect(searched).toBeLessThanOrEqual(wire.length * 4);
});

test("aborting a subscription cancels a blocked stream read", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const reading = readEvents(
    body,
    () => {
      throw new Error("Unexpected event");
    },
    controller.signal,
  );
  controller.abort();
  await reading;
  expect(cancelled).toBe(true);
});

test("an unterminated frame is not delivered as a complete snapshot", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: snapshot\ndata: partial"));
      controller.close();
    },
  });
  const received: string[] = [];
  await readEvents(body, (event) => received.push(event.data), new AbortController().signal);
  expect(received).toEqual([]);
});

test("SSE accepts bare CR delimiters at the end of a completed frame", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: snapshot\rdata: value\r\r"));
      controller.close();
    },
  });
  const received: string[] = [];
  await readEvents(body, (event) => received.push(event.data), new AbortController().signal);
  expect(received).toEqual(["value"]);
});

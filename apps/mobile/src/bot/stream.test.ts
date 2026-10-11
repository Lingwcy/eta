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

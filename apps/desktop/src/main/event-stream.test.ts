import { expect, test, vi } from "vite-plus/test";
import { EventStreamFrames } from "./event-stream.ts";

test("frame delimiters survive every split, adjacent frames and empty reads", () => {
  const wire = "event: snapshot\ndata: 你好\n\nevent: heartbeat\n\n\n\ndata: last\n\n";
  const expected = ["event: snapshot\ndata: 你好", "event: heartbeat", "", "data: last"];
  for (let split = 0; split <= wire.length; split++) {
    const frames = new EventStreamFrames();
    expect([
      ...frames.push(wire.slice(0, split)),
      ...frames.push(""),
      ...frames.push(wire.slice(split)),
    ]).toEqual(expected);
  }
  const frames = new EventStreamFrames();
  expect(wire.split("").flatMap((char) => [...frames.push(char)])).toEqual(expected);
});

test("a large fragmented snapshot searches only newly received data", () => {
  const frame = `event: snapshot\ndata: ${JSON.stringify({ text: "长上下文".repeat(250_000) })}`;
  const wire = frame + "\n\n";
  const frames = new EventStreamFrames();
  const received: string[] = [];
  let searched = 0;
  const spy = vi.spyOn(String.prototype, "indexOf");
  try {
    for (let offset = 0; offset < wire.length; offset += 1024)
      received.push(...frames.push(wire.slice(offset, offset + 1024)));
    for (const [index, call] of spy.mock.calls.entries())
      searched += String(spy.mock.contexts[index]).length - (call[1] ?? 0);
  } finally {
    spy.mockRestore();
  }
  expect(received).toEqual([frame]);
  expect(searched).toBeLessThanOrEqual(wire.length + 2);
});

import { readEvents } from "../stream.ts";

const size = 8 * 1024 * 1024;
const step = Number(process.argv[2]);
const prefix = new TextEncoder().encode('event: snapshot\ndata: {"text":"');
const payload = new Uint8Array(size).fill(120);
const suffix = new TextEncoder().encode('"}\n\n');
let phase = 0;
let offset = 0;
let delivered = 0;
const body = new ReadableStream({
  pull(controller) {
    if (phase === 0) {
      phase = 1;
      controller.enqueue(prefix);
    } else if (offset < size) {
      const end = Math.min(offset + step, size);
      controller.enqueue(payload.subarray(offset, end));
      offset = end;
    } else if (phase === 1) {
      phase = 2;
      controller.enqueue(suffix);
    } else controller.close();
  },
});
await readEvents(
  body,
  ({ event, data }) => {
    const { text } = JSON.parse(data);
    if (event !== "snapshot" || text.length !== size || !/^x+$/.test(text))
      throw new Error("Fragmented payload changed");
    delivered++;
  },
  new AbortController().signal,
);
if (delivered !== 1 || body.locked) throw new Error("Event or reader lifecycle changed");
console.log(JSON.stringify({ delivered, size, step, locked: body.locked }));

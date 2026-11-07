import { EventStreamFrames } from "../event-stream.ts";

const size = 8 * 1024 * 1024;
const step = Number(process.argv[2]);
const wire =
  'event: snapshot\ndata: {"text":"' + "x".repeat(size) + '"}\n\nevent: heartbeat\ndata: {}\n\n';
const parser = new EventStreamFrames();
let delivered = 0;
for (let offset = 0; offset < wire.length; offset += step) {
  for (const frame of parser.push(wire.slice(offset, offset + step))) {
    const lines = frame.split("\n");
    const data = JSON.parse(lines.find((line) => line.startsWith("data: ")).slice(6));
    if (delivered === 0) {
      if (lines[0] !== "event: snapshot" || data.text.length !== size || !/^x+$/.test(data.text))
        throw new Error("Fragmented payload changed");
    } else if (delivered !== 1 || lines[0] !== "event: heartbeat" || Object.keys(data).length !== 0)
      throw new Error("Frame reset changed");
    delivered++;
  }
}
if (delivered !== 2) throw new Error("Frame count changed");
console.log(JSON.stringify({ size, step, delivered }));

/** Accumulate normalized SSE frames without rescanning or copying unfinished prefixes. */
export class EventStreamFrames {
  private parts: string[] = [];
  private trailingNewline = false;

  *push(chunk: string): Generator<string> {
    if (!chunk) return;
    let start = 0;
    if (this.trailingNewline && chunk.startsWith("\n")) {
      const last = this.parts.length - 1;
      this.parts[last] = this.parts[last]!.slice(0, -1);
      const frame = this.parts.join("");
      this.parts = [];
      this.trailingNewline = false;
      start = 1;
      yield frame;
    }
    let end: number;
    while ((end = chunk.indexOf("\n\n", start)) >= 0) {
      this.parts.push(chunk.slice(start, end));
      const frame = this.parts.join("");
      this.parts = [];
      this.trailingNewline = false;
      start = end + 2;
      yield frame;
    }
    if (start < chunk.length) {
      this.parts.push(chunk.slice(start));
      this.trailingNewline = chunk.endsWith("\n");
    }
  }
}

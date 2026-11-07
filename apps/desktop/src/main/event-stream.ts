/** Accumulate normalized SSE frames with bounded fragment metadata and linear assembly. */
export class EventStreamFrames {
  private parts: string[] = [];
  private blocks: string[] = [];
  private trailingNewline = false;

  *push(chunk: string): Generator<string> {
    if (!chunk) return;
    let start = 0;
    if (this.trailingNewline && chunk.startsWith("\n")) {
      const last = this.parts.length - 1;
      this.parts[last] = this.parts[last]!.slice(0, -1);
      const frame = [...this.blocks, ...this.parts].join("");
      this.blocks = [];
      this.parts = [];
      this.trailingNewline = false;
      start = 1;
      yield frame;
    }
    let end: number;
    while ((end = chunk.indexOf("\n\n", start)) >= 0) {
      this.parts.push(chunk.slice(start, end));
      const frame = [...this.blocks, ...this.parts].join("");
      this.blocks = [];
      this.parts = [];
      this.trailingNewline = false;
      start = end + 2;
      yield frame;
    }
    if (start < chunk.length) {
      this.parts.push(chunk.slice(start));
      if (this.parts.length > 1024) {
        // Keep the last read separate so a split delimiter can still remove its final newline.
        const tail = this.parts.pop()!;
        this.blocks.push(this.parts.join(""));
        this.parts = [tail];
      }
      this.trailingNewline = chunk.endsWith("\n");
    }
  }
}

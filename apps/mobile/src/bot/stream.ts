export interface ServerEvent {
  event: string;
  data: string;
}

const MAX_EVENT_CHARS = 64 * 1024 * 1024;

/** Accept arbitrary byte boundaries, including a CRLF or UTF-8 character split across reads. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  receive: (event: ServerEvent) => void,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let fragments: string[] = [];
  let lineSize = 0;
  let skipLF = false;
  let event = "message";
  let data: string[] = [];
  let frameSize = 0;
  const line = (value: string) => {
    if (value === "") {
      if (data.length) receive({ event, data: data.join("\n") });
      event = "message";
      data = [];
      frameSize = 0;
    } else if (value.startsWith("event:")) {
      event = value.slice(6).replace(/^ /, "");
    } else if (value.startsWith("data:")) {
      frameSize += value.length;
      if (frameSize > MAX_EVENT_CHARS) throw new Error("Bot 实时消息过大，请重新打开会话");
      data.push(value.slice(5).replace(/^ /, ""));
    }
  };
  const append = (fragment: string) => {
    if (!fragment) return;
    lineSize += fragment.length;
    if (lineSize > MAX_EVENT_CHARS) throw new Error("Bot 实时消息过大，请重新打开会话");
    fragments.push(fragment);
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      // A CR completes a line immediately; swallow its optional LF across reads.
      let start = skipLF && chunk.startsWith("\n") ? 1 : 0;
      skipLF = chunk.endsWith("\r");
      const endings = /\r\n|\n|\r/g;
      endings.lastIndex = start;
      let match: RegExpExecArray | null;
      while ((match = endings.exec(chunk))) {
        append(chunk.slice(start, match.index));
        line(fragments.join(""));
        fragments = [];
        lineSize = 0;
        start = match.index + match[0].length;
      }
      // Retain unfinished fragments, not a growing string to scan again on every read.
      append(chunk.slice(start));
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

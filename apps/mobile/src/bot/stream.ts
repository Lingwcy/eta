export interface ServerEvent {
  event: string;
  data: string;
}

/** Accept arbitrary byte boundaries, including a CRLF or UTF-8 character split across reads. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  receive: (event: ServerEvent) => void,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
      if (frameSize > 64 * 1024 * 1024) throw new Error("Bot 实时消息过大，请重新打开会话");
      data.push(value.slice(5).replace(/^ /, ""));
    }
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer === "\r") line("");
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // A stream carries snapshots; bound malformed events without truncating valid frames.
      if (buffer.length > 64 * 1024 * 1024) throw new Error("Bot 实时消息过大，请重新打开会话");
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
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

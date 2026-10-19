import type { SSEStreamingApi } from "hono/streaming";

/** Keep idle observations alive without queuing heartbeats behind a stalled reader. */
export function heartbeat(stream: Pick<SSEStreamingApi, "writeSSE">, onError: () => void) {
  let stopped = false;
  let writing = false;
  const timer = setInterval(() => {
    if (stopped || writing) return;
    writing = true;
    void stream
      .writeSSE({ event: "heartbeat", data: "{}" })
      .catch(() => {
        if (!stopped) onError();
      })
      .finally(() => {
        writing = false;
      });
  }, 15000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

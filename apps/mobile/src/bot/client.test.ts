import { expect, test, vi } from "vite-plus/test";
import { BotClient, normalizeConnection } from "./client.ts";
import { json, library, requestUrl } from "./fixtures.test-support.ts";

test("connection validation rejects credential URLs, query strings and unsupported schemes", () => {
  for (const url of [
    "ftp://bot",
    "https://name:secret@bot",
    "https://bot?token=secret",
    "https://bot#hash",
    "bad",
  ])
    expect(() => normalizeConnection({ url, token: "secret" })).toThrow();
  expect(normalizeConnection({ url: " https://bot/base/// ", token: " secret " })).toEqual({
    url: "https://bot/base",
    token: "secret",
  });
});

test("HTTP requests use bearer authentication and safely encode thread IDs", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new BotClient({ url: "https://bot/base", token: "secret" }, async (url, init) => {
    calls.push({ url: requestUrl(url), init });
    return json({ stopped: true });
  });
  await client.stop("id/with space");
  expect(calls[0]?.url).toBe("https://bot/base/v1/threads/id%2Fwith%20space/stop");
  expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" });
  expect(calls[0]?.init?.redirect).toBe("error");
});

test("invalid Bot responses fail at the transport boundary", async () => {
  const client = new BotClient({ url: "https://bot", token: "secret" }, async () =>
    json({ ...library, models: null }),
  );
  await expect(client.library()).rejects.toMatchObject({ code: "InvalidResponse" });
});

test("unauthorized SSE stops reconnecting and reports an actionable error", async () => {
  let requests = 0;
  const client = new BotClient({ url: "https://bot", token: "secret" }, async () => {
    ++requests;
    return json({ error: { code: "Unauthorized", message: "Unauthorized" } }, 401);
  });
  const errors: { fatal?: boolean; message?: string }[] = [];
  await client.watch(
    "thread",
    new AbortController().signal,
    () => {},
    (message, fatal) => errors.push({ message, fatal }),
  );
  expect(requests).toBe(1);
  expect(errors).toEqual([{ fatal: true, message: "Bot 令牌无效，请修改连接设置" }]);
});

test.each([
  { streaming: false, cancelFails: false },
  { streaming: true, cancelFails: false },
  { streaming: true, cancelFails: true },
])("401 rejects without reading a stalled body: %j", async ({ streaming, cancelFails }) => {
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        read.resolve();
        return release.promise;
      },
      cancel() {
        cancelled = true;
        if (cancelFails) throw new Error("Body cancellation failed");
      },
    },
    { highWaterMark: 0 },
  );
  const client = new BotClient(
    { url: "https://bot", token: "secret" },
    async () => new Response(body, { status: 401 }),
  );
  const abort = new AbortController();
  const errors: { message?: string; fatal?: boolean }[] = [];
  const work = streaming
    ? client
        .watch(
          "thread",
          abort.signal,
          () => {},
          (message, fatal) => errors.push({ message, fatal }),
        )
        .then(() => errors[0])
    : client.library(abort.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
  try {
    const outcome = await Promise.race([
      work.then((value) => ({ kind: "done" as const, value })),
      read.promise.then(() => ({ kind: "body-read" as const })),
    ]);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("The client waited for an unauthorized body");
    if (streaming)
      expect(outcome.value).toEqual({ message: "Bot 令牌无效，请修改连接设置", fatal: true });
    else expect(outcome.value).toMatchObject({ code: "Unauthorized", status: 401 });
    expect(cancelled).toBe(true);
  } finally {
    abort.abort();
    if (!cancelled) controller.close();
    release.resolve();
    await work;
  }
});

test.each([400, 503])("non-401 HTTP %s retains its error code and diagnostic", async (status) => {
  const response = json(
    { error: { code: "ServerDiagnostic", message: "Controlled diagnostic" } },
    status,
  );
  const client = new BotClient({ url: "https://bot", token: "secret" }, async () => response);
  await expect(client.library()).rejects.toMatchObject({
    code: "ServerDiagnostic",
    message: "Controlled diagnostic",
    status,
  });
  expect(response.bodyUsed).toBe(true);
});

test("a JSON response stalled after headers still times out", async () => {
  const client = new BotClient(
    { url: "https://bot", token: "secret" },
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("Aborted")), {
              once: true,
            });
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    10,
  );
  await expect(client.library()).rejects.toMatchObject({ code: "Timeout" });
});

test("older and newer Bot snapshots both decode while automatic review details survive HTTP", async () => {
  const { thread } = await import("./fixtures.test-support.ts");
  const approval = {
    id: "request",
    tool: "bash",
    args: { command: "git commit" },
    reason: "Commit",
    status: "consumed",
    networkAccess: false,
    readableRoots: ["/repo/.git"],
    writableRoots: ["/repo/.git/objects"],
    decidedBy: "auto",
    reuse: "run",
    review: {
      status: "approved",
      rationale: "Routine",
      reviewer: { provider: "test", modelId: "one" },
      toolCalls: [{ tool: "git", summary: "git status" }],
    },
  };
  let response: unknown = thread;
  const client = new BotClient({ url: "https://bot", token: "secret" }, async () => json(response));
  expect((await client.open("thread")).snapshot.approvalHistory).toBeUndefined();
  response = {
    ...thread,
    snapshot: { ...thread.snapshot, approvalHistory: [approval] },
  };
  const opened = await client.open("thread");
  expect(opened.snapshot.approvalHistory).toMatchObject([
    {
      decidedBy: "auto",
      reuse: "run",
      review: { reviewer: { modelId: "one" }, toolCalls: [{ summary: "git status" }] },
    },
  ]);
});

test("a silent stream is replaced after three missed heartbeats", async () => {
  vi.useFakeTimers();
  try {
    let requests = 0;
    const controller = new AbortController();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const client = new BotClient({ url: "https://bot", token: "secret" }, async (url) => {
      if (!new URL(requestUrl(url)).pathname.endsWith("/events")) return json({});
      requests += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            streams.push(stream);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const statuses: { message?: string; fatal?: boolean }[] = [];
    void client.watch(
      "thread",
      controller.signal,
      () => {},
      (message, fatal) => statuses.push({ message, fatal }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toBe(2);
    expect(statuses).toEqual([{ message: "实时连接中断，正在重连", fatal: false }]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toBe(2);
    expect(streams.length).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("transport heartbeats keep a quiet stream alive", async () => {
  vi.useFakeTimers();
  try {
    let requests = 0;
    const controller = new AbortController();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const client = new BotClient({ url: "https://bot", token: "secret" }, async (url) => {
      if (!new URL(requestUrl(url)).pathname.endsWith("/events")) return json({});
      requests += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            stream = value;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const statuses: unknown[] = [];
    void client.watch(
      "thread",
      controller.signal,
      () => {},
      (...status) => statuses.push(status),
    );
    await vi.advanceTimersByTimeAsync(0);
    const encoder = new TextEncoder();
    for (let frame = 0; frame < 6; frame++) {
      stream.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(requests).toBe(1);
    expect(statuses).toEqual([]);
    controller.abort();
  } finally {
    vi.useRealTimers();
  }
});

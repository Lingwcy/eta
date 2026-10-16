import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { constants, createGzip } from "node:zlib";
import { compress } from "hono/compress";
import { createMiddleware } from "hono/factory";
import { parseAccept } from "hono/utils/accept";

/** Flush every SSE write: ordinary gzip buffering can hide small events indefinitely. */
export const compressEvents = createMiddleware(async (context, next) => {
  await next();
  if (
    !context.res.body ||
    !context.res.headers.get("content-type")?.startsWith("text/event-stream")
  )
    return;
  context.res.headers.append("Vary", "Accept-Encoding");
  const accepted = parseAccept(context.req.header("Accept-Encoding") ?? "");
  const gzip =
    accepted.find((encoding) => encoding.type.toLowerCase() === "gzip") ??
    accepted.find((encoding) => encoding.type === "*");
  if (!gzip || gzip.q <= 0 || context.res.headers.has("Content-Encoding")) return;
  const source = Readable.fromWeb(context.res.body as NodeReadableStream<Uint8Array>);
  const encoded = source.compose(createGzip({ flush: constants.Z_SYNC_FLUSH }));
  const headers = new Headers(context.res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  context.res = new Response(Readable.toWeb(encoded) as ReadableStream<Uint8Array>, {
    status: context.res.status,
    headers,
  });
});

export const compressJson = compress({ contentTypeFilter: /^application\/json\b/ });

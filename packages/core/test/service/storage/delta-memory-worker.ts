import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { track } from "@earendil-works/chord/delta";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import { MemoryStorage } from "@eta/agent/storage/memory";
import type { DocumentId, Storage } from "@eta/agent";
import { ROOT_CONVERSATION_ID } from "@eta/agent";

const [backend, directory] = process.argv.slice(2);
assert.ok(backend === "memory" || backend === "jsonl");
assert.ok(directory);
assert.ok(globalThis.gc, "Run the worker with --expose-gc");
const context = BACKGROUND_CONTEXT;
let storage: Storage =
  backend === "memory" ? new MemoryStorage() : await openNodeJsonlStorage(directory, context);
await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
const id = await storage.mintId<DocumentId>();
const tracker = track({ generation: { partialJson: '{"code":"import React from "' } });
// Include non-ASCII and lone surrogates: detaching through UTF-8 would change the stored text.
const chunk = " ".repeat(506) + "中😀\ud800 \udfff";

try {
  await storage.commit(
    [
      {
        type: "document.create",
        record: {
          id,
          kind: "stream",
          scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
          history: "latest",
          fork: "initial",
        },
        content: { kind: "base", version: 1, value: tracker.value },
      },
    ],
    context,
  );
  globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;
  let peakRetained = 0;
  for (let index = 1; index <= 1_000; index++) {
    const text = tracker.value.generation.partialJson + chunk;
    // Streaming argument parsing flattens the growing rope before the tracker takes its suffix.
    assert.throws(() => JSON.parse(text));
    const change = tracker.beginChange();
    change.state.generation.partialJson = text;
    const prepared = change.prepare();
    await storage.commit(
      [{ type: "document.change", id, content: { kind: "delta", version: 1, ops: prepared.ops } }],
      context,
    );
    tracker.adopt(prepared);
    if (index % 250 === 0) {
      globalThis.gc();
      const retained = process.memoryUsage().heapUsed - baseline;
      peakRetained = Math.max(peakRetained, retained);
      assert.ok(
        retained < 32 * 1024 * 1024,
        `${backend}: ${index} updates retain ${retained} bytes`,
      );
    }
  }
  assert.deepEqual((await storage.document(id, "current", context))?.value, tracker.value);
  if (backend === "jsonl") {
    await storage.close(context);
    storage = await openNodeJsonlStorage(directory, context);
    assert.deepEqual((await storage.document(id, "current", context))?.value, tracker.value);
  }
  console.log(
    `${backend}: streamed text remains intact within the heap budget; peak retained ${peakRetained} bytes`,
  );
} finally {
  await storage.close(context);
}

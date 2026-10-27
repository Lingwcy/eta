import assert from "node:assert/strict";
import { Effect } from "effect";
import { ObservationService } from "../../../src/service/observation/index.ts";
import type { ThreadRuntime } from "../../../src/service/runtime/index.ts";

const data = "a".repeat(24 * 1024 * 1024);
const message = {
  role: "user" as const,
  content: [{ type: "image" as const, data, mimeType: "image/png" }],
  timestamp: 1,
  optional: undefined,
};
const view = {
  docs: {},
  entries: [{ id: 1, conversationId: "conversation", model: [message] }],
};
let stopped = 0;
const runtime = {
  conversation: {
    id: "conversation",
    watch: async () => ({
      value: view,
      start: () => {},
      stop: async () => {
        stopped++;
      },
    }),
  },
  storage: { scanSubmissions: async () => ({ items: [] }) },
  ref: { metadata: { createdAt: 0 } },
  harness: { snapshot: async () => undefined },
  approvals: { list: async () => [], history: async () => [] },
  sandbox: async () => ({ mode: "workspace" }),
  subagents: { list: async () => [] },
  watches: new Set(),
  changes: new Set(),
} as unknown as ThreadRuntime;

const observation = await Effect.runPromise(
  Effect.provide(ObservationService, ObservationService.layer),
);
const first = await Effect.runPromise(observation.snapshot(runtime));
const result = first.snapshot.transcript[0]!.message;
assert.equal(result.role, "user");
assert.ok(Array.isArray(result.content));
assert.deepEqual(result.content[0], message.content[0]);
assert.ok(!Object.hasOwn(result, "optional"));
assert.notEqual(result, message);
assert.notEqual(result.content, message.content);
result.content.length = 0;
assert.equal(message.content.length, 1);
assert.equal(stopped, 1);

const delivered = Promise.withResolvers<void>();
const stop = await Effect.runPromise(
  observation.subscribe(
    runtime,
    (value) => {
      assert.deepEqual(value.snapshot.transcript[0]!.message, {
        role: "user",
        content: message.content,
        timestamp: 1,
      });
      delivered.resolve();
    },
    (error) => delivered.reject(new Error(error)),
  ),
);
try {
  await delivered.promise;
} finally {
  stop();
}
assert.equal(stopped, 2);
console.log("large snapshot and subscription remain detached within the heap budget");

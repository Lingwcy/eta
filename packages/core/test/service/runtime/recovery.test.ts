import { expect, test } from "vite-plus/test";
import {
  requiresRecovery,
  hasForegroundWork,
  hasPersistedWork,
} from "@eta/core/service/runtime/recovery";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import { ROOT_CONVERSATION_ID, type StorageWrite, type TaskId, type TaskRecord } from "@eta/agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TITLE_TASK_KIND } from "@eta/core/agent/extension/title/task";

test("background title generation is the only pending task that can resume silently", () => {
  const title = {
    submissions: [],
    tasks: [{ record: { kind: TITLE_TASK_KIND, background: true } }],
  };
  expect(requiresRecovery(title)).toBe(false);
  expect(hasForegroundWork(title)).toBe(false);
  expect(requiresRecovery({ submissions: [], tasks: [] })).toBe(false);
  expect(
    requiresRecovery({
      ...title,
      tasks: [{ record: { kind: TITLE_TASK_KIND, background: false } }],
    }),
  ).toBe(true);
});

test.each(["pending", "running", "waiting", "sleeping", "completing"] as const)(
  "definition-free inspection scans past background title pages to %s work",
  async (status) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-cold-inspection-"));
    const storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT);
    try {
      await storage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        BACKGROUND_CONTEXT,
      );
      const writes: StorageWrite[] = [];
      for (let i = 0; i < 65; i++) {
        writes.push({
          type: "task",
          value: {
            id: await storage.mintId<TaskId<null>>(),
            conversationId: ROOT_CONVERSATION_ID,
            kind: TITLE_TASK_KIND,
            version: 1,
            input: null,
            background: true,
            abortRequested: false,
            state: { status: "pending", checkpoint: null },
          },
        });
      }
      await storage.commit(writes, BACKGROUND_CONTEXT);
      expect(await hasPersistedWork(storage)).toBe(false);
      const work = {
        id: await storage.mintId<TaskId<null>>(),
        conversationId: ROOT_CONVERSATION_ID,
        kind: "test.background-host",
        version: 1,
        input: null,
        background: true,
        abortRequested: false,
      };
      const live: TaskRecord<null, null, null> =
        status === "completing"
          ? { ...work, state: { status, outcome: { status: "completed", result: null } } }
          : status === "waiting"
            ? { ...work, state: { status, checkpoint: null, on: [], policy: "failFast" } }
            : status === "sleeping"
              ? { ...work, state: { status, checkpoint: null, until: Date.now() + 60_000 } }
              : { ...work, state: { status, checkpoint: null } };
      await storage.commit([{ type: "task", value: live }], BACKGROUND_CONTEXT);
      expect(await hasPersistedWork(storage)).toBe(true);
      await storage.commit(
        [
          {
            type: "task",
            value: {
              ...work,
              state: { status: "terminal", outcome: { status: "completed", result: null } },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      expect(await hasPersistedWork(storage)).toBe(false);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("pending submissions and background delegates require explicit recovery", () => {
  const pendingInput = { submissions: [{ status: "queued" }], tasks: [] };
  expect(requiresRecovery(pendingInput)).toBe(true);
  expect(hasForegroundWork(pendingInput)).toBe(true);
  const delegate = {
    submissions: [],
    tasks: [{ record: { kind: "eta.subagent-reporter", background: true } }],
  };
  expect(requiresRecovery(delegate)).toBe(true);
  expect(hasForegroundWork(delegate)).toBe(true);
});

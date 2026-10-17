import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@eta/agent";
import type { EntryId, SubmissionId, SubmissionRecord, TaskId } from "@eta/agent";
import { expect, test } from "vite-plus/test";
import { readOperationOrigin } from "../../../src/service/threads/origin.ts";

function input(id: number, entry: number, requestId: string, answer?: number): SubmissionRecord {
  const base = {
    id: id as SubmissionId,
    entry: entry as EntryId,
    requestId,
    type: "input" as const,
    conversationId: ROOT_CONVERSATION_ID,
  };
  return answer === undefined
    ? { ...base, status: "placed" }
    : { ...base, status: "done", answer: answer as EntryId };
}

async function stored(
  submissions: SubmissionRecord[],
  tasks: { id: number; kind?: string; conversationId?: number }[],
) {
  const storage = new MemoryStorage();
  await storage.commit(
    [
      ...submissions.map((value) => ({ type: "submission" as const, value })),
      ...tasks.map(
        ({ id, kind = "eta.subagent-reporter", conversationId = ROOT_CONVERSATION_ID }) => ({
          type: "task" as const,
          value: {
            id: id as TaskId<null>,
            conversationId: conversationId as typeof ROOT_CONVERSATION_ID,
            kind,
            version: 1,
            input: {},
            background: true,
            abortRequested: false,
            state: {
              status: "terminal" as const,
              outcome: { status: "completed" as const, result: null },
            },
          },
        }),
      ),
    ],
    BACKGROUND_CONTEXT,
  );
  return storage;
}

test.each(["eta.subagent-reporter", "eta.subagent-timeout"])(
  "attributes a legacy %s follow-up to the actual spawning input",
  async (kind) => {
    const root = input(10, 9, "schedule:automatic:review", 40);
    const report = input(51, 50, "subagent-report:20");
    const storage = await stored([root, report], [{ id: 20, kind }]);
    expect(await readOperationOrigin(storage, report)).toBe("10");
  },
);

test("follows multiple generations of autonomous reports", async () => {
  const root = input(10, 9, "schedule:manual:review", 40);
  const first = input(51, 50, "subagent-report:20", 80);
  const second = input(101, 100, "subagent-report:60");
  const storage = await stored([root, first, second], [{ id: 20 }, { id: 60 }]);
  expect(await readOperationOrigin(storage, second)).toBe("10");
});

test("accepts merged report inputs only when they share one origin", async () => {
  const root = input(10, 9, "schedule:automatic:review", 100);
  const first = input(51, 50, "subagent-report:20", 100);
  const second = input(151, 150, "subagent-report:60");
  const storage = await stored([root, first, second], [{ id: 20 }, { id: 60 }]);
  expect(await readOperationOrigin(storage, second)).toBe("10");
});

test.each([
  "expired",
  "missing-task",
  "other-kind",
  "other-conversation",
  "future-task",
  "malformed-id",
  "ambiguous",
  "failed-owner",
])("keeps the origin unknown when the spawning evidence is %s", async (reason) => {
  let root = input(10, 9, "schedule:automatic:old", reason === "expired" ? 15 : 40);
  if (reason === "failed-owner")
    root = {
      ...root,
      status: "unanswered",
      answer: undefined,
      reason: "model_error",
    } as SubmissionRecord;
  const report = input(
    51,
    50,
    reason === "malformed-id"
      ? "subagent-report:unknown"
      : `subagent-report:${reason === "future-task" ? 60 : 20}`,
  );
  const storage = await stored(
    [root, ...(reason === "ambiguous" ? [input(12, 11, "ordinary", 40)] : []), report],
    reason === "missing-task"
      ? []
      : [
          {
            id: reason === "future-task" ? 60 : 20,
            kind: reason === "other-kind" ? "unrelated-host-task" : undefined,
            conversationId: reason === "other-conversation" ? 2 : undefined,
          },
        ],
  );
  expect(await readOperationOrigin(storage, report)).toBeUndefined();
});

test("an ordinary spawning turn wins over an older schedule in the same conversation", async () => {
  const old = input(2, 1, "schedule:automatic:old", 5);
  const ordinary = input(10, 9, "ordinary", 40);
  const report = input(51, 50, "subagent-report:20");
  const storage = await stored([old, ordinary, report], [{ id: 20 }]);
  expect(await readOperationOrigin(storage, report)).toBe("10");
});

test.each([1, 100])(
  "finds origin %s across receipt pages independently of placement order",
  async (id) => {
    const old = Array.from({ length: 80 }, (_, index) =>
      input(index + 2, index + 1, `ordinary-${index}`, index + 2),
    );
    // This input was admitted first but placed much later from its queue.
    const root = input(id, 99, "schedule:automatic:review", 140);
    const report = input(151, 150, "subagent-report:120");
    const storage = await stored([...old, root, report], [{ id: 120 }]);
    expect(await readOperationOrigin(storage, report)).toBe(String(id));
  },
);

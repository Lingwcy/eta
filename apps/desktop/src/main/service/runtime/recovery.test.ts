import { expect, test } from "vite-plus/test";
import { requiresRecovery, hasForegroundWork } from "./recovery.ts";
import { TITLE_TASK_KIND } from "../../../agent/extension/title/task.ts";

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

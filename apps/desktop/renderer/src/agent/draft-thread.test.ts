import { expect, test, vi } from "vite-plus/test";
import { DraftThread } from "./draft-thread";

function setup() {
  const createThread = vi.fn(async (_workspace: string, _request: string) => ({ id: "persisted" }));
  const submit = vi.fn(async (_id: string, _prompt: string) => ({
    operationId: "run",
    kind: "run" as const,
    startedAt: 1,
  }));
  return {
    createThread,
    submit,
    draft: new DraftThread("draft-request", { createThread, submit }),
  };
}

test("a draft stays local until a nonempty message has a selected project", async () => {
  const { draft, createThread, submit } = setup();
  expect(draft.persistedId).toBeUndefined();
  await expect(draft.submit(null, "Hello")).rejects.toThrow("选择项目");
  await expect(draft.submit("selected-project", "  ")).rejects.toThrow("请输入消息");
  expect(createThread).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await expect(draft.submit("selected-project", "  Hello  ")).resolves.toBe("persisted");
  expect(createThread).toHaveBeenCalledExactlyOnceWith("selected-project", "draft-request");
  expect(submit).toHaveBeenCalledExactlyOnceWith("persisted", "Hello");
});

test("repeated sends while creation is pending share one thread and one admission", async () => {
  const { draft, createThread, submit } = setup();
  let finish!: (value: { id: string }) => void;
  createThread.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = draft.submit("project", "First message");
  const duplicate = draft.submit("project", "First message");
  expect(first).toBe(duplicate);
  expect(submit).not.toHaveBeenCalled();
  finish({ id: "persisted" });
  await first;
  expect(createThread).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("a failed admission can retry without creating a second thread or changing its project", async () => {
  const { draft, createThread, submit } = setup();
  submit.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(draft.submit("project", "Hello")).rejects.toThrow("Provider unavailable");
  expect(draft.persistedId).toBe("persisted");
  await expect(draft.submit("other-project", "Hello")).rejects.toThrow("不能切换项目");
  await expect(draft.submit("project", "Hello")).resolves.toBe("persisted");
  expect(createThread).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(2);
});

test("creation failures preserve the idempotency key for retry", async () => {
  const { draft, createThread, submit } = setup();
  createThread.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(draft.submit("project", "Hello")).rejects.toThrow("Storage unavailable");
  expect(draft.persistedId).toBeUndefined();
  expect(submit).not.toHaveBeenCalled();
  await draft.submit("project", "Hello");
  expect(createThread.mock.calls).toEqual([
    ["project", "draft-request"],
    ["project", "draft-request"],
  ]);
});

test("an image-only draft still requires a project and forwards the image on first admission", async () => {
  const { draft, submit, createThread } = setup();
  const images = [
    { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" },
  ];
  await expect(draft.submit(null, "", images)).rejects.toThrow("选择项目");
  expect(createThread).not.toHaveBeenCalled();
  await draft.submit("project", "", images);
  expect(submit).toHaveBeenCalledWith("persisted", "", images);
});

test("a failed cloud configuration preserves the created thread and admits no message until retry", async () => {
  const { createThread, submit } = setup();
  const configureThread = vi
    .fn()
    .mockRejectedValueOnce(new Error("Bot disconnected"))
    .mockResolvedValue({});
  const draft = new DraftThread("cloud-draft", { createThread, submit, configureThread });
  const configuration = { provider: "cloud", modelId: "one", thinkingLevel: "off" as const };
  await expect(
    draft.submit("bot:server:workspace", "Cloud work", undefined, configuration),
  ).rejects.toThrow("Bot disconnected");
  expect(draft.persistedId).toBe("persisted");
  expect(submit).not.toHaveBeenCalled();
  await expect(
    draft.submit("bot:server:workspace", "Cloud work", undefined, configuration),
  ).resolves.toBe("persisted");
  expect(createThread).toHaveBeenCalledTimes(1);
  expect(configureThread).toHaveBeenLastCalledWith("persisted", "cloud", "one", "off");
  expect(submit).toHaveBeenCalledExactlyOnceWith("persisted", "Cloud work");
});

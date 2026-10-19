import { expect, test, vi } from "vite-plus/test";
import { DraftThread } from "./draft-thread";
import { DesktopCommandError } from "../../../src/command-reply.ts";

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
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    "persisted",
    "Hello",
    undefined,
    expect.any(String),
  );
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
  expect(submit).toHaveBeenCalledWith("persisted", "", images, expect.any(String));
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
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    "persisted",
    "Cloud work",
    undefined,
    expect.any(String),
  );
});

const worktreeInput = {
  projectId: "project",
  baseWorkspaceId: "base",
  branch: { kind: "new" as const, name: "eta/work" },
};
const worktreeReceipt = {
  requestId: "create",
  projectId: "project",
  workspaceId: "worktree",
  path: "/worktree",
  cwd: "/worktree",
  branch: "eta/work",
  baseSha: "base",
  createdBranch: true,
  managed: true,
  status: "ready" as const,
  createdAt: 1,
};

test("a failed first send in a worktree keeps the actual execution workspace for retry", async () => {
  const { createThread, submit } = setup();
  const createWorktree = vi.fn(async () => worktreeReceipt);
  submit.mockRejectedValueOnce(new Error("Provider unavailable"));
  const draft = new DraftThread("thread-request", { createThread, submit, createWorktree });
  await expect(draft.submit("base", "Hello", undefined, undefined, worktreeInput)).rejects.toThrow(
    "Provider unavailable",
  );
  expect(draft.persistedWorkspaceId).toBe("worktree");
  await draft.submit("base", "Hello", undefined, undefined, worktreeInput);
  expect(createThread).toHaveBeenCalledExactlyOnceWith("worktree", "thread-request");
  expect(createWorktree).toHaveBeenCalledTimes(1);
  await expect(
    draft.submit("other", "Hello", undefined, undefined, {
      ...worktreeInput,
      baseWorkspaceId: "other",
    }),
  ).rejects.toThrow("不能切换项目");
});

test("worktree creation retries use one receipt and empty messages never create a directory", async () => {
  const { createThread, submit } = setup();
  const createWorktree = vi.fn(
    async (_input: import("@eta/core/service/git/worktrees").CreateWorktreeInput) =>
      worktreeReceipt,
  );
  createWorktree.mockRejectedValueOnce(new Error("Connection lost"));
  const draft = new DraftThread("thread-request", { createThread, submit, createWorktree });
  await expect(draft.submit("base", " ", undefined, undefined, worktreeInput)).rejects.toThrow(
    "请输入消息",
  );
  expect(createWorktree).not.toHaveBeenCalled();
  await expect(draft.submit("base", "Hello", undefined, undefined, worktreeInput)).rejects.toThrow(
    "Connection lost",
  );
  await draft.submit("base", "Hello", undefined, undefined, worktreeInput);
  expect(createWorktree.mock.calls[0]).toEqual(createWorktree.mock.calls[1]);
  expect(createThread).toHaveBeenCalledTimes(1);
});

test("changing the branch after thread creation fails creates the newly selected worktree", async () => {
  const { createThread, submit } = setup();
  const createWorktree = vi.fn(
    async (_input: import("@eta/core/service/git/worktrees").CreateWorktreeInput) =>
      worktreeReceipt,
  );
  createThread.mockRejectedValueOnce(new Error("Storage unavailable"));
  const draft = new DraftThread("thread-request", { createThread, submit, createWorktree });
  await expect(draft.submit("base", "Hello", undefined, undefined, worktreeInput)).rejects.toThrow(
    "Storage unavailable",
  );
  await draft.submit("base", "Hello", undefined, undefined, {
    ...worktreeInput,
    branch: { kind: "new", name: "eta/other" },
  });
  const first = createWorktree.mock.calls[0]![0];
  const second = createWorktree.mock.calls[1]![0];
  expect(second.branch.name).toBe("eta/other");
  expect(second.requestId).not.toBe(first.requestId);
});

test("duplicate sends during worktree creation share one creation and one message", async () => {
  const { createThread, submit } = setup();
  let finish!: (value: typeof worktreeReceipt) => void;
  const createWorktree = vi.fn(
    () =>
      new Promise<typeof worktreeReceipt>((resolve) => {
        finish = resolve;
      }),
  );
  const draft = new DraftThread("thread-request", { createThread, submit, createWorktree });
  const first = draft.submit("base", "Hello", undefined, undefined, worktreeInput);
  expect(draft.submit("base", "Hello", undefined, undefined, worktreeInput)).toBe(first);
  finish(worktreeReceipt);
  await first;
  expect(createWorktree).toHaveBeenCalledTimes(1);
  expect(createThread).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("an uncertain draft admission keeps its identity and a definite rejection does not", async () => {
  const calls: (string | undefined)[] = [];
  const submit = vi.fn(async (...args: unknown[]) => {
    calls.push(args.at(-1) as string | undefined);
    if (calls.length === 1)
      throw new DesktopCommandError({
        code: "BotRequestFailed",
        message: "Request timed out",
        retryable: true,
      });
    return { operationId: "run", kind: "run" as const, startedAt: 1 };
  });
  const draft = new DraftThread("draft-request", {
    createThread: vi.fn(async () => ({ id: "persisted" })),
    submit,
  });
  await expect(draft.submit("project", "Hello")).rejects.toThrow("Request timed out");
  await expect(draft.submit("project", "Hello")).resolves.toBe("persisted");
  expect(calls[0]).toBeTruthy();
  expect(calls[1]).toBe(calls[0]);
  await expect(draft.submit("project", "Other work")).resolves.toBe("persisted");
  expect(calls[2]).not.toBe(calls[0]);

  const rejected: (string | undefined)[] = [];
  const rejecting = new DraftThread("draft-request", {
    createThread: vi.fn(async () => ({ id: "persisted" })),
    submit: vi.fn(async (...args: unknown[]) => {
      rejected.push(args.at(-1) as string | undefined);
      throw new DesktopCommandError({ code: "Busy", message: "Please wait", retryable: false });
    }),
  });
  await expect(rejecting.submit("project", "Hello")).rejects.toThrow("Please wait");
  await expect(rejecting.submit("project", "Hello")).rejects.toThrow("Please wait");
  expect(rejected[1]).not.toBe(rejected[0]);
});

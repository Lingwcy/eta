// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { LoginMethod, LoginState } from "../../../src/authentication.ts";
import { useAuthentication } from "./use-authentication";
import { LoginDialog } from "@/components/settings/authentication/login-dialog";

type Phase = "answer" | "read" | "error";
async function fixture(phase: Phase, method: LoginMethod = "api_key", dialog = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const release = Promise.withResolvers<void>();
  const nextStart = Promise.withResolvers<void>();
  const states = new Map<string, LoginState>();
  const cancelled = new Set<string>();
  let entered = false;
  let answered = false;
  let holdNext = false;
  let active: string | undefined;
  const connected = vi.fn(async () => {});
  const read = (id: string) => {
    const state = states.get(id);
    if (!state) throw new Error("Unknown flow");
    return state;
  };
  vi.stubGlobal("eta", {
    startLogin: async (provider: string) => {
      const state: LoginState = {
        id: provider,
        provider,
        method,
        status: "running",
        message: "Test login",
        links: [],
        prompt: { id: provider + "-prompt", type: "secret", message: "Test key" },
      };
      states.set(provider, state);
      active = provider;
      if (provider === "next" && holdNext) await nextStart.promise;
      return structuredClone(state);
    },
    answerLogin: async (id: string) => {
      answered = true;
      if (phase !== "read") {
        entered = true;
        await release.promise;
      }
      if (phase === "error") throw new Error("Simulated submit failure");
      const state = read(id);
      if (state.status === "running") state.status = "completed";
    },
    loginState: async (id: string) => {
      if (id !== active) throw new Error("Flow replaced");
      const state = structuredClone(read(id));
      if (id === "first" && phase === "read" && answered && !cancelled.has(id)) {
        entered = true;
        await release.promise;
      }
      return state;
    },
    cancelLogin: async (id: string) => {
      cancelled.add(id);
      const state = read(id);
      if (state.status === "running") state.status = "cancelled";
    },
  });
  let value: ReturnType<typeof useAuthentication> | undefined;
  function Host() {
    value = useAuthentication(connected);
    return dialog
      ? createElement(LoginDialog, { auth: value, name: "Test provider" })
      : createElement("output", null, value.login?.id ?? "closed");
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Host)));
  } catch (error) {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    throw error;
  }
  const get = () => {
    if (!value) throw new Error("Hook not mounted");
    return value;
  };
  const pending: Promise<void>[] = [];
  return {
    get,
    connected,
    release: () => release.resolve(),
    holdNext: () => {
      holdNext = true;
    },
    releaseNext: () => nextStart.resolve(),
    async begin() {
      await act(async () => {
        await get().start("first", method);
      });
      await act(async () => {
        const work = get().answer("first-prompt", "test-only-key");
        pending.push(work);
        void work.catch(() => {});
      });
      await expect.poll(() => entered, { timeout: 1000 }).toBe(true);
    },
    async startNext() {
      await act(async () => {
        const work = get().start("next", method);
        pending.push(work);
        void work.catch(() => {});
      });
    },
    async settleAnswer() {
      await act(async () => {
        release.resolve();
        await pending[0];
      });
    },
    async settle() {
      await act(async () => {
        release.resolve();
        await Promise.allSettled(pending);
      });
    },
    async cleanup() {
      await act(async () => {
        release.resolve();
        nextStart.resolve();
        await Promise.allSettled(pending);
        root.unmount();
      });
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    },
  };
}

test.each(
  (["answer", "read", "error"] as const).flatMap((phase) =>
    [false, true].flatMap((close) =>
      (["api_key", "oauth"] as const).map((method) => ({ phase, close, method })),
    ),
  ),
)(
  "submission continuation respects closed authentication (phase=$phase, close=$close, method=$method)",
  async ({ phase, close, method }) => {
    const state = await fixture(phase, method);
    try {
      await state.begin();
      if (close) {
        await act(async () => {
          await state.get().close();
        });
        expect(state.get().login).toBeNull();
      }
      await state.settle();
      expect(state.get().busy).toBe(false);
      if (close) {
        expect(state.get().login).toBeNull();
        expect(state.get().error).toBeNull();
        expect(state.connected).toHaveBeenCalledTimes(phase === "read" ? 1 : 0);
      } else if (phase === "error") {
        expect(state.get().login?.id).toBe("first");
        expect(state.get().error).not.toBeNull();
      } else {
        expect(state.get().login?.status).toBe("completed");
        expect(state.connected).toHaveBeenCalledOnce();
      }
    } finally {
      await state.cleanup();
    }
  },
);

test("a cancelled submission cannot clear the next login's busy state", async () => {
  const state = await fixture("answer");
  try {
    await state.begin();
    await act(async () => {
      await state.get().close();
    });
    state.holdNext();
    await state.startNext();
    expect(state.get().busy).toBe(true);
    // Do not await the pending new start when settling only the old answer.
    await state.settleAnswer();
    await expect.poll(() => state.get().login?.id, { timeout: 1000 }).not.toBe("first");
    expect(state.get().busy).toBe(true);
    await act(async () => state.releaseNext());
    await expect.poll(() => state.get().login?.id, { timeout: 1000 }).toBe("next");
  } finally {
    await state.cleanup();
  }
});

test("Escape closes a busy login dialog without a late submission reopening it", async () => {
  const state = await fixture("answer", "api_key", true);
  try {
    await state.begin();
    expect(state.get().busy).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await expect.poll(() => state.get().login, { timeout: 1000 }).toBeNull();
    await state.settleAnswer();
    expect(state.get().login).toBeNull();
    expect(state.get().error).toBeNull();
  } finally {
    await state.cleanup();
  }
});

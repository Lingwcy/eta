// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { LoginState } from "../../../src/authentication.ts";
import { LoginDialog } from "@/components/settings/authentication/login-dialog";
import { useAuthentication } from "./use-authentication";

const cases = (["api_key", "oauth"] as const).flatMap((method) =>
  (["poll", "answer"] as const).flatMap((held) => [
    { method, held, stale: true, reject: false },
    { method, held, stale: true, reject: true },
    { method, held, stale: false, reject: true },
  ]),
);

test.each(cases)(
  "ordered login reads: $method, held=$held, stale=$stale, reject=$reject",
  async ({ method, held, stale, reject }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const gate = Promise.withResolvers<void>();
    const server: LoginState = {
      id: "flow",
      provider: "test",
      method,
      status: "running",
      message: "First step",
      links: [],
      prompt: {
        id: "first",
        type: method === "oauth" ? "manual_code" : "secret",
        message: "First code",
      },
    };
    let reads = 0;
    let captured = false;
    const connected = vi.fn(async () => {});
    vi.stubGlobal("eta", {
      startLogin: async () => structuredClone(server),
      loginState: async () => {
        const snapshot = structuredClone(server);
        const read = ++reads;
        if (read === (held === "poll" ? 1 : 2)) {
          captured = true;
          await gate.promise;
          if (reject) throw new Error("Held read failed");
        }
        return snapshot;
      },
      answerLogin: async (_id: string, prompt: string, value: string) => {
        if (prompt !== server.prompt?.id) throw new Error("Step ended");
        if (prompt === "second") {
          if (value !== "eu") throw new Error("Invalid region");
          server.status = "completed";
          server.prompt = undefined;
          return;
        }
        server.prompt = {
          id: "second",
          type: "select",
          message: "Choose region",
          options: [{ id: "eu", label: "Europe" }],
        };
        server.message = "Second step";
      },
      cancelLogin: async () => {},
    });
    let value: ReturnType<typeof useAuthentication> | undefined;
    function Host() {
      value = useAuthentication(connected);
      return createElement(LoginDialog, { auth: value, name: "Test provider" });
    }
    const get = () => {
      if (!value) throw new Error("Hook not mounted");
      return value;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let submission: Promise<void> | undefined;
    try {
      await act(async () => root.render(createElement(Host)));
      await act(async () => {
        await get().start("test", method);
      });
      expect(reads).toBe(1);
      if (held === "answer" || stale) {
        await act(async () => {
          submission = get().answer("first", "test-only-code");
        });
        if (held === "poll")
          await act(async () => {
            await submission;
          });
      }
      if (held === "answer" && stale) {
        server.message = "Latest provider progress";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(350);
        });
        expect(get().login?.message).toBe("Latest provider progress");
      }
      expect(captured).toBe(true);
      await act(async () => {
        gate.resolve();
        await submission;
      });
      expect(get().busy).toBe(false);
      if (!stale) {
        expect(get().error).not.toBeNull();
        return;
      }
      expect(get().error).toBeNull();
      expect(get().login?.prompt?.id).toBe("second");
      expect(get().login?.message).toBe(
        held === "poll" ? "Second step" : "Latest provider progress",
      );
      // This is the actual LoginPromptForm, not a static projection of hook props.
      expect(
        [...document.querySelectorAll("label")].some(
          (label) => label.textContent === "Choose region",
        ),
      ).toBe(true);
      if (held === "poll" && reject) {
        // A superseded polling error must not silently end observation.
        server.status = "completed";
        server.prompt = undefined;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(350);
        });
      } else {
        const picker = document.querySelector<HTMLButtonElement>('[role="combobox"]');
        expect(picker).not.toBeNull();
        await act(async () => {
          picker?.click();
        });
        const option = document.querySelector<HTMLElement>('[role="option"]');
        expect(option?.textContent).toContain("Europe");
        await act(async () => {
          option?.click();
        });
        const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]');
        expect(submit?.disabled).toBe(false);
        await act(async () => {
          submit?.click();
        });
      }
      expect(get().login?.status).toBe("completed");
      expect(connected).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        gate.resolve();
        await submission;
        root.unmount();
      });
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
  },
);

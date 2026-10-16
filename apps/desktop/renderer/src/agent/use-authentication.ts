import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useEffect, useRef, useState } from "react";
import type { LoginMethod, LoginState } from "../../../src/authentication.ts";

/** One modal follows pi-ai's interaction steps; closing it cancels the underlying login. */
export function useAuthentication(onConnected: () => Promise<void>) {
  const [login, setLogin] = useState<LoginState | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(null);
  const mounted = useRef(false);
  const refreshed = useRef<string | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (current.current) void window.eta.cancelLogin(current.current).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!login || login.status !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.eta.loginState(login.id);
        if (stopped) return;
        setLogin(next);
        if (next.status === "running") timer = setTimeout(() => void poll(), 350);
      } catch {
        if (!stopped)
          setError(localizedMessage("chat:useAuthentication.cannotReadSignInProgressCancelAnd"));
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login?.id, login?.status]);

  useEffect(() => {
    if (!login || login.status === "running") return;
    current.current = null;
    if (login.status !== "completed" || refreshed.current === login.id) return;
    refreshed.current = login.id;
    void connected.current().catch(() => {
      if (mounted.current)
        setError(
          localizedMessage("chat:useAuthentication.connectedButRefreshingTheModelListFailed"),
        );
    });
  }, [login?.id, login?.status]);

  return {
    login,
    error,
    busy,
    start: async (provider: string, method: LoginMethod) => {
      if (current.current) return;
      setBusy(true);
      setError(null);
      try {
        const next = await window.eta.startLogin(provider, method);
        if (!mounted.current) {
          await window.eta.cancelLogin(next.id);
          return;
        }
        current.current = next.id;
        setLogin(next);
      } catch (error) {
        if (mounted.current)
          setError(
            describeError(error, localizedMessage("chat:useAuthentication.cannotStartSignIn")),
          );
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    close: async () => {
      setBusy(true);
      try {
        const id = current.current;
        if (id) {
          await window.eta.cancelLogin(id);
          const result = await window.eta.loginState(id);
          if (result.status === "completed" && refreshed.current !== result.id) {
            refreshed.current = result.id;
            await connected.current();
          }
        }
        current.current = null;
        if (mounted.current) {
          setLogin(null);
          setError(null);
        }
      } catch {
        if (mounted.current)
          setError(localizedMessage("chat:useAuthentication.cannotCancelSignInTryAgain"));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    answer: async (promptId: string, value: string) => {
      if (!login) return;
      setBusy(true);
      setError(null);
      try {
        await window.eta.answerLogin(login.id, promptId, value);
        if (mounted.current) setLogin(await window.eta.loginState(login.id));
      } catch (error) {
        if (mounted.current)
          setError(
            describeError(
              error,
              localizedMessage("chat:useAuthentication.cannotSubmitSignInInformation"),
            ),
          );
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    openLink: async (url: string) => {
      if (!login) return;
      try {
        await window.eta.openLoginLink(login.id, url);
      } catch {
        if (mounted.current)
          setError(
            localizedMessage("chat:useAuthentication.cannotOpenTheBrowserCopyTheAuthorization"),
          );
      }
    },
  };
}

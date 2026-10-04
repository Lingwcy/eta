import { useEffect, useRef, useState } from "react";
import type { BrowserTab } from "@/agent/desktop-tabs";
import type { BrowserClient, BrowserViewState } from "./client";

export function useBrowserPage(
  tab: BrowserTab,
  visible: boolean,
  client: BrowserClient,
  state: BrowserViewState | undefined,
) {
  const [address, setAddress] = useState(tab.url);
  const [ready, setReady] = useState(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const hasUrl = tab.url !== "";
  useEffect(() => {
    return () => {
      void client.command({ type: "close", id: tab.id });
    };
  }, [client, tab.id]);
  useEffect(() => {
    setAddress(state?.page?.url ?? tab.url);
  }, [state?.page?.url, tab.url]);
  useEffect(() => {
    if (!hasUrl) return;
    let cancelled = false;
    setReady(false);
    void client.command({ type: "create", id: tab.id, url: tab.url }).then((created) => {
      if (!cancelled) setReady(created);
    });
    return () => {
      cancelled = true;
    };
  }, [client, tab.id, hasUrl]);
  useEffect(() => {
    if (!ready || !visible) return;
    const element = viewport.current!;
    const resize = () => {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      void client.command({
        type: "show",
        id: tab.id,
        bounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        },
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      observer.disconnect();
      void client.command({ type: "hide", id: tab.id });
    };
  }, [client, ready, visible, tab.id]);
  useEffect(() => {
    if (visible && !hasUrl) addressInput.current?.focus();
  }, [visible, hasUrl]);
  const navigate = async () => {
    // Main normalizes both addresses and searches before allocating a guest page.
    const success = await client.command({
      type: ready ? "navigate" : "create",
      id: tab.id,
      url: address,
    });
    if (success) addressInput.current?.blur();
  };
  const command = async (type: "back" | "forward" | "reload" | "stop") => {
    if (type === "reload" && !ready) await navigate();
    else await client.command({ type, id: tab.id });
  };
  return {
    address,
    setAddress,
    addressInput,
    viewport,
    ready,
    navigate,
    command,
    page: state?.page,
    error: state?.error ?? state?.page?.error,
  };
}

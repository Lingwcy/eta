export interface BrowserState {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  preview?: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type BrowserCommand =
  | { type: "create" | "navigate"; id: string; url: string }
  | { type: "show"; id: string; bounds: BrowserBounds }
  | { type: "back" | "forward" | "reload" | "stop" | "close" | "capture" | "hide"; id: string };

export type DesktopShortcut =
  | "new-chat"
  | "new-browser"
  | "close-tab"
  | "reopen-tab"
  | "settings"
  | "toggle-sidebar"
  | "next-tab"
  | "previous-tab"
  | "focus-address"
  | { select: number };

export type BrowserEvent =
  | { type: "state"; state: BrowserState }
  | { type: "open"; url: string }
  | { type: "shortcut"; action: DesktopShortcut };

/** Address-bar inputs can be URLs or a search; only web URLs enter guest contents. */
export function browserAddress(input: string) {
  const text = input.trim();
  if (!text) throw new Error("请输入网址或搜索内容");
  if (/^https?:\/\//i.test(text)) return new URL(text).href;
  if (/^[a-z][\w+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:\/|$)/.test(text))
    throw new Error("浏览器仅支持 http 和 https 网址");
  if (
    !/\s/.test(text) &&
    (/^(?:localhost|\[[\da-f:]+\])(?::\d+)?(?:\/|$)/i.test(text) ||
      /^[\w\p{L}-]+(?:\.[\w\p{L}-]+)+(?::\d+)?(?:[/?#]|$)/u.test(text))
  ) {
    return new URL(`${/^(?:localhost|127\.)/.test(text) ? "http" : "https"}://${text}`).href;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

export function desktopShortcut(input: {
  key: string;
  meta?: boolean;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
}): DesktopShortcut | undefined {
  const key = input.key.toLowerCase();
  if (input.control && key === "tab" && !input.alt)
    return input.shift ? "previous-tab" : "next-tab";
  if (!(input.meta || input.control) || input.alt) return;
  if (/^[1-9]$/.test(key)) return { select: Number(key) - 1 };
  if (key === "t") return input.shift ? "reopen-tab" : "new-browser";
  if (input.shift) return;
  return (
    {
      n: "new-chat",
      w: "close-tab",
      ",": "settings",
      b: "toggle-sidebar",
      l: "focus-address",
    } as const
  )[key as "n" | "w" | "," | "b" | "l"];
}

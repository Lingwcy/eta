import { LocalizedError } from "../shared/i18n/messages.ts";
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
  | "toggle-inspector"
  | "next-tab"
  | "previous-tab"
  | "focus-address"
  | { select: number };

export type BrowserEvent =
  | { type: "state"; state: BrowserState }
  | { type: "open"; url: string }
  | { type: "shortcut"; action: DesktopShortcut };

function parsed(url: string) {
  try {
    return new URL(url);
  } catch {
    // A malformed port or host must reach the user as an address message, not a raw TypeError.
    throw new LocalizedError("errors:protocol.enterAUrlOrSearchQuery");
  }
}

/** LAN targets rarely serve TLS; extend the localhost exception to private, link-local and wildcard hosts. */
function localHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "0.0.0.0") return true;
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

/** Address-bar inputs can be URLs or a search; only web URLs enter guest contents. */
export function browserAddress(input: string) {
  const text = input.trim();
  if (!text) throw new LocalizedError("errors:protocol.enterAUrlOrSearchQuery");
  if (/^https?:\/\//i.test(text)) return parsed(text).href;
  if (/^[a-z][\w+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(text))
    throw new LocalizedError("errors:protocol.theBrowserOnlySupportsHttpAndHttpsUrls");
  if (
    !/\s/.test(text) &&
    (/^(?:localhost|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(text) ||
      /^[\w\p{L}-]+(?:\.[\w\p{L}-]+)+(?::\d+)?(?:[/?#]|$)/u.test(text))
  ) {
    const { hostname } = parsed(`https://${text}`);
    // Reparse the input so changing the default scheme cannot discard an explicit port.
    return parsed(`${localHostname(hostname) ? "http" : "https"}://${text}`).href;
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
  if (input.alt && key === "arrowleft" && !input.meta && !input.control && !input.shift)
    return "toggle-inspector";
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

import { ComputerError } from "./protocol.ts";

const supported = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  ...Array.from({ length: 20 }, (_, index) => `f${index + 1}`),
  "cmd",
  "control",
  "shift",
  "alt",
  "fn",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "escape",
  "home",
  "end",
  "pageup",
  "pagedown",
  "left",
  "right",
  "up",
  "down",
]);
const aliases: Readonly<Record<string, string>> = {
  command: "cmd",
  meta: "cmd",
  option: "alt",
  ctrl: "control",
  enter: "return",
  esc: "escape",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  page_up: "pageup",
  page_down: "pagedown",
};

/** Validate the whole chord before any native key is pressed. */
export function normalizeComputerKeys(keys: readonly string[]): string[] {
  if (!keys.length || keys.length > 8)
    throw new ComputerError(
      "invalid_input",
      "key requires 1–8 keys, e.g. ['enter'] or ['command','a']",
    );
  const normalized = keys.map((value) => {
    const lower = value.trim().toLowerCase();
    const key = Object.hasOwn(aliases, lower) ? aliases[lower]! : lower;
    if (!supported.has(key))
      throw new ComputerError(
        "invalid_input",
        `Unsupported key: ${value}. Use enter, escape, tab, arrows, or a chord such as ['command','a'].`,
      );
    return key;
  });
  return [...new Set(normalized)];
}

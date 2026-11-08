import type { AppearanceSnapshot } from "./appearance.ts";

/** Only non-sensitive, validated startup data crosses the sandbox's argv boundary. */
export function parseInitialAppearance(args: readonly string[]): AppearanceSnapshot {
  const prefix = "--eta-appearance=";
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const parts = value?.split(":") ?? [];
  const [preference, resolved, revision] = parts;
  if (
    parts.length === 3 &&
    (preference === "system" || preference === "light" || preference === "dark") &&
    (resolved === "light" || resolved === "dark") &&
    (preference === "system" || preference === resolved) &&
    revision !== undefined &&
    /^[0-9]+$/.test(revision) &&
    Number.isSafeInteger(Number(revision))
  )
    return { preference, resolved, revision: Number(revision) };
  return { preference: "system", resolved: "light", revision: 0 };
}

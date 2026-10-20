import type { SettingsCategory } from "./settings-categories";

/** An unknown or removed category falls back to the default page instead of an empty area. */
export function chooseCategory(
  candidate: string | undefined,
  known: ReadonlySet<string>,
  fallback: SettingsCategory,
): SettingsCategory {
  return candidate && known.has(candidate) ? (candidate as SettingsCategory) : fallback;
}

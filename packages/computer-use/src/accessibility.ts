/** Keep the full native map internally; only shorten observations when every changed line is retained. */
export function accessibilityDiff(previous: string, current: string) {
  const before = new Set(previous.split("\n"));
  const after = new Set(current.split("\n"));
  const removed = [...before].filter((line) => !after.has(line));
  const added = [...after].filter((line) => !before.has(line));
  const update = [
    "Accessibility update. Unchanged lines retain their indexes; use this result's NEW frameId for all actions.",
    ...(removed.length ? ["Removed:", ...removed] : []),
    ...(added.length ? ["Added/changed:", ...added] : []),
    ...(!removed.length && !added.length ? ["No accessibility changes."] : []),
  ].join("\n");
  return update.length < current.length ? update : current;
}

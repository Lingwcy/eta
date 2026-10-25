import { expect, test } from "vite-plus/test";
import { accessibilityDiff } from "../src/accessibility.ts";

test("incremental state retains every removed and added line and avoids repeating unchanged controls", () => {
  const unchanged = Array.from(
    { length: 30 },
    (_, i) => `[${i + 10}] AXButton label=unchanged-${i}`,
  ).join("\n");
  const before = `[1] AXTextField value=old\n${unchanged}`;
  const after = `[1] AXTextField value=new\n${unchanged}`;
  const result = accessibilityDiff(before, after);
  expect(result).toContain("Removed:\n[1] AXTextField value=old");
  expect(result).toContain("Added/changed:\n[1] AXTextField value=new");
  expect(result).not.toContain("unchanged-29");
  expect(result.length).toBeLessThan(after.length);
  expect(accessibilityDiff(after, after)).toContain("No accessibility changes");
});

test("returns a full tree when a diff would be larger", () => {
  expect(accessibilityDiff("[1] AXButton old", "[1] AXButton new")).toBe("[1] AXButton new");
});

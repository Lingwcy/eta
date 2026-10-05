import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { readAgentSettings } from "./agent-settings.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(content?: string) {
  const directory = await mkdtemp(join(tmpdir(), "eta-legacy-settings-"));
  directories.push(directory);
  const path = join(directory, "settings.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
}

test("reads legacy model defaults without modifying the shared settings file", async () => {
  const content = JSON.stringify({
    defaultProvider: " opencode-go ",
    defaultModel: " deepseek-v4-flash ",
    defaultThinkingLevel: "high",
    unrelatedSetting: true,
  });
  const path = await fixture(content);
  expect(await readAgentSettings(path)).toEqual({
    defaultProvider: "opencode-go",
    defaultModel: "deepseek-v4-flash",
    defaultThinkingLevel: "high",
  });
  expect(await readFile(path, "utf8")).toBe(content);
});

test("missing legacy settings leave desktop defaults unchanged", async () => {
  expect(await readAgentSettings(await fixture())).toEqual({});
});

test.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
  "accepts the legacy thinking level %s",
  async (defaultThinkingLevel) => {
    const path = await fixture(JSON.stringify({ defaultThinkingLevel }));
    expect(await readAgentSettings(path)).toEqual({ defaultThinkingLevel });
  },
);

test.each([
  ["{", "有效的 JSON"],
  ["[]", "JSON 对象"],
  ['{"defaultProvider": ""}', "defaultProvider"],
  ['{"defaultModel": 42}', "defaultModel"],
  ['{"defaultThinkingLevel": "unknown"}', "defaultThinkingLevel"],
])("invalid legacy settings %s report a useful error", async (content, error) => {
  const path = await fixture(content);
  await expect(readAgentSettings(path)).rejects.toThrow(error);
  expect(await readFile(path, "utf8")).toBe(content);
});

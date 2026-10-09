import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GenerationTask, ROOT_CONVERSATION_ID, hook } from "@eta/agent";
import type { Harness, Registry, Conversation } from "@eta/agent";
import { omitImages } from "../../images/content.ts";
import type { RuntimeSettings } from "../../shared/runtime-settings.ts";
import type { SkillCatalog } from "../../skills/types.ts";
import type { createSubagentsExtension } from "../../agent/extension/subagent/index.ts";
import { createSkillsExtension, SkillsDoc } from "../skills/extension.ts";

export function createRuntimeTools({
  registry,
  harness,
  subagents,
  readSettings,
  skillCatalog,
}: {
  registry: Registry;
  harness: () => Harness | undefined;
  subagents: ReturnType<typeof createSubagentsExtension>;
  readSettings: () => Promise<RuntimeSettings>;
  skillCatalog: () => Promise<SkillCatalog>;
}) {
  const codingTools = registry.snapshot().extension("coding-tools")!;
  let skills = createSkillsExtension(
    { directories: [], skills: [], issues: [] },
    { defaultThinkingLevel: "off" },
  );
  const refreshTools = async () => {
    const settings = await readSettings();
    const subagentsEnabled = settings.subagents?.enabled !== false;
    // Keep task definitions installed so existing delegates can finish or be stopped while disabled.
    registry.install({
      ...subagents.extension,
      tools: subagentsEnabled ? [subagents.tool, subagents.updateTool] : [subagents.updateTool],
    });
    const disabled = new Set<string>(settings.disabledTools ?? []);
    registry.install({
      ...codingTools,
      tools: codingTools.tools?.filter((tool) => !disabled.has(tool.name)),
    });
    const state =
      harness() && (await harness()!.snapshot(SkillsDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT));
    skills = createSkillsExtension(await skillCatalog(), settings, Boolean(state?.active.length));
    registry.install(skills.extension);
    if (harness()) {
      const root = await harness()!.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      await root?.configure(
        {
          tools:
            subagentsEnabled && settings.subagents?.mode === "orchestrator"
              ? [subagents.tool]
              : { remove: [subagents.updateTool] },
        },
        BACKGROUND_CONTEXT,
      );
    }
  };
  registry.install({
    name: "desktop-image-settings",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }) =>
          (await readSettings()).blockImages ? { messages: omitImages(messages) } : undefined,
      }),
    ],
  });
  return {
    refresh: refreshTools,
    prepareSkills: (conversation: Conversation, prompt: string) =>
      skills.activateExplicit(conversation, prompt, harness()!),
  };
}

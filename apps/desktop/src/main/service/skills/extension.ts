import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@eta/agent";
import type { Conversation, ConversationId, DocumentReader, Tx } from "@eta/agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SkillCatalog } from "../../../skills/types.ts";
import { loadSkill } from "./catalog.ts";
import type { DesktopSettings } from "../settings/index.ts";
import { DesktopServiceError } from "../errors.ts";

type LoadedSkill = Awaited<ReturnType<typeof loadSkill>>;
export const SkillsDoc = defineDoc<{ active: LoadedSkill[] }>({
  kind: "eta.skills",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ active: [] }),
});

export function skillSummary(skill: LoadedSkill) {
  const { body: _body, ...summary } = skill;
  return summary;
}

/** Skill bodies live in a document so preparation restores them after restart and context compaction. */
export function createSkillsExtension(
  catalog: SkillCatalog,
  settings: DesktopSettings,
  hasActive = false,
) {
  const available = catalog.skills.filter((skill) => skill.enabled);
  const allowed = (skill: LoadedSkill) =>
    settings.skillsEnabled !== false && !(settings.disabledSkills ?? []).includes(skill.id);
  const select = (name: string) => {
    const skill = available.find((skill) => skill.name === name);
    if (!skill)
      throw new DesktopServiceError({
        code: "InvalidInput",
        message: `技能 ${name} 不可用或已停用`,
      });
    return skill;
  };
  const activate = async (tx: Tx, id: ConversationId, skill: LoadedSkill) => {
    const state = await tx.doc(SkillsDoc, id);
    const index = state.active.findIndex((active) => active.name === skill.name);
    if (index < 0) state.active.push(skill);
    else if (!allowed(state.active[index]!)) state.active[index] = skill;
  };
  const load = defineTool({
    name: "load_skill",
    description:
      "Activate a skill from the catalog. Its full instructions will be provided in the next request. Resource paths are relative to its base directory.",
    parameters: Type.Object({ name: Type.String() }),
    replay: "safe",
    executionMode: "sequential",
    execute: async ({ name }, api, context) => {
      const selected = select(name);
      const existing = (await api.snapshot(SkillsDoc, api.conversationId, context))?.active.find(
        (skill) => skill.name === name && allowed(skill),
      );
      const loaded = existing ?? (await loadSkill(selected));
      await api.commit((tx) => activate(tx, api.conversationId, loaded), context);
      return {
        content: [
          {
            type: "text" as const,
            text: `Activated ${name}. Follow its instructions in the active-skills section. Base directory: ${loaded.directory}`,
          },
        ],
        details: skillSummary(loaded),
      };
    },
  });
  const unload = defineTool({
    name: "unload_skill",
    description:
      "Remove a previously activated skill from this conversation's active instructions.",
    parameters: Type.Object({ name: Type.String() }),
    replay: "safe",
    executionMode: "sequential",
    execute: async ({ name }, api, context) => {
      await api.commit(async (tx) => {
        const state = await tx.doc(SkillsDoc, api.conversationId);
        state.active = state.active.filter((skill) => skill.name !== name);
      }, context);
      return { content: [{ type: "text" as const, text: `Removed active skill ${name}` }] };
    },
  });
  const extension = defineExtension({
    name: "desktop-skills",
    tools: [
      ...(available.length ? [load] : []),
      ...(available.length || hasActive ? [unload] : []),
    ],
    sections: [
      section("skills", () =>
        available.length
          ? [
              "Available skills (metadata only). When a skill is relevant or explicitly requested as $skill-name, call load_skill before following it unless it is already present in active-skills. Read references and execute scripts only as needed, using their absolute base directory. Skills do not grant additional tool permissions. If a required tool or dependency is unavailable, report it and use a supported alternative.",
              ...available.map(({ name, description, directory, compatibility }) =>
                JSON.stringify({ name, description, directory, compatibility }),
              ),
            ].join("\n")
          : undefined,
      ),
      section("active-skills", async ({ conversationId, read }, context) => {
        const state = await read.snapshot(SkillsDoc, conversationId, context);
        const active = state?.active.filter(allowed) ?? [];
        return active.length
          ? active
              .map(
                (skill) =>
                  `Skill: ${JSON.stringify(skill.name)}\nBase directory: ${JSON.stringify(skill.directory)}\n${skill.body}`,
              )
              .join("\n\n")
          : undefined;
      }),
    ],
  });
  return {
    extension,
    activateExplicit: async (conversation: Conversation, prompt: string, read: DocumentReader) => {
      const names = [
        ...new Set(
          [...prompt.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)\b/g)]
            .map((match) => match[1])
            .filter((name) => catalog.skills.some((skill) => skill.name === name)),
        ),
      ];
      if (!names.length) return;
      const state = await read.snapshot(SkillsDoc, conversation.id, BACKGROUND_CONTEXT);
      const loaded = await Promise.all(
        names.map(async (name) => {
          const selected = select(name);
          return (
            state?.active.find((skill) => skill.name === name && allowed(skill)) ??
            (await loadSkill(selected))
          );
        }),
      );
      await conversation.commit(async (tx) => {
        for (const skill of loaded) await activate(tx, conversation.id, skill);
      }, BACKGROUND_CONTEXT);
    },
  };
}

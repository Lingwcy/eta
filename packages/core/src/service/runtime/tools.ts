import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GenerationTask, LiveDoc, ROOT_CONVERSATION_ID, hook } from "@eta/agent";
import type { Harness, Registry, Conversation, Extension, Storage } from "@eta/agent";
import { omitImages } from "../../images/content.ts";
import type { RuntimeSettings } from "../../shared/runtime-settings.ts";
import type { SkillCatalog } from "../../skills/types.ts";
import type { createSubagentsExtension } from "../../agent/extension/subagent/index.ts";
import { createSkillsExtension, SkillsDoc } from "../skills/extension.ts";
import { InputsDoc, RecoveryDoc } from "../runs/inputs.ts";
import { boundComputerImages } from "../../computer/images.ts";

export function createRuntimeTools({
  registry,
  storage,
  harness,
  subagents,
  schedule,
  readSettings,
  skillCatalog,
}: {
  registry: Registry;
  storage: Storage;
  harness: () => Harness | undefined;
  subagents: ReturnType<typeof createSubagentsExtension>;
  schedule: ReturnType<typeof import("../schedules/extension.ts").createScheduleExtension>["tool"];
  readSettings: () => Promise<RuntimeSettings>;
  skillCatalog: () => Promise<SkillCatalog>;
}) {
  const codingTools = registry.snapshot().extension("coding-tools")!;
  const codemode = registry.snapshot().extension("codemode")!.tools![0]!;
  let computer: Extension | undefined;
  let skills = createSkillsExtension(
    { directories: [], skills: [], issues: [] },
    { defaultThinkingLevel: "off" },
  );
  const refreshTools = async () => {
    const settings = await readSettings();
    computer ??= registry.snapshot().extension("computer");
    if (computer)
      registry.install({
        ...computer,
        tools: settings.computerUse && !settings.blockImages ? computer.tools : [],
      });
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
    skills = createSkillsExtension(
      await skillCatalog(),
      settings,
      Boolean(state?.active.length),
      async (conversationId) => {
        if (conversationId !== ROOT_CONVERSATION_ID) return;
        const active = await harness()!.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
        const root = await harness()!.conversation(conversationId, BACKGROUND_CONTEXT);
        if (!root) return;
        const records =
          (await harness()!.snapshot(InputsDoc, conversationId, BACKGROUND_CONTEXT))?.records ?? [];
        const activeInputs = new Set((active?.run?.inputs ?? []).map(Number));
        for (const record of records) {
          if (record.skillsPrepared && !record.recoverable) continue;
          const id =
            record.id ??
            (
              await storage.submissionByRequest(
                conversationId,
                record.requestId,
                BACKGROUND_CONTEXT,
              )
            )?.id;
          if (id === undefined || !activeInputs.has(id)) continue;
          if (!record.skillsPrepared) {
            const recovery = await harness()!.snapshot(
              RecoveryDoc,
              conversationId,
              record.requestId,
              BACKGROUND_CONTEXT,
            );
            await skills.activateExplicit(
              root,
              recovery?.prompt ?? record.prompt ?? "",
              harness()!,
            );
          }
          await root.commit(async (tx) => {
            const doc = await tx.doc(InputsDoc, conversationId);
            const current = doc.records.find((current) => current.requestId === record.requestId);
            if (current) {
              current.skillsPrepared = true;
              delete current.prompt;
              current.recoverable = false;
              await tx.retireDoc(RecoveryDoc, conversationId, record.requestId);
            }
          }, BACKGROUND_CONTEXT);
        }
      },
    );
    registry.install(skills.extension);
    if (harness()) {
      const root = await harness()!.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      await root?.configure(
        {
          tools:
            subagentsEnabled && settings.subagents?.mode === "orchestrator"
              ? [
                  codemode,
                  subagents.tool,
                  schedule,
                  ...(registry.snapshot().extension("computer")?.tools ?? []),
                ]
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
        beforeRequest: async ({ messages }) => ({
          messages: (await readSettings()).blockImages
            ? omitImages(messages)
            : boundComputerImages(messages),
        }),
      }),
    ],
  });
  return {
    refresh: refreshTools,
    prepareSkills: (conversation: Conversation, prompt: string) =>
      skills.activateExplicit(conversation, prompt, harness()!),
  };
}

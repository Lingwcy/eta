import { AgentDoc, NestedCallDoc, defineDoc } from "@eta/agent";
import type { ConversationId, Tx } from "@eta/agent";
import { CodemodeRunDoc, createCodemodeExtension } from "@eta/agent/codemode";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { CodemodeRunOptions } from "@earendil-works/pi-codemode";
import type { AgentMode } from "../../shared/runtime-settings.ts";
import { Predicate } from "effect";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { computerImageDigests } from "../../computer/images.ts";

/** Missing records belong to executions started before Code mode was introduced. */
export const AgentModeDoc = defineDoc<{ mode: AgentMode }>({
  kind: "eta.agent-mode",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ mode: "standard" }),
  checkpointWhen: () => false,
});

export const codemodeLimits = {
  timeoutMs: 5 * 60 * 1000,
  memoryLimitBytes: 128 * 1024 * 1024,
  workers: 4,
} as const;

// Capacity belongs to the host, across threads, and is released only on actual worker exit.
let workers = 0;
export class RuntimeCodemodeSandbox extends CodemodeSandbox {
  constructor(assets?: { workerUrl: URL; wasmPath: string }) {
    const wasm = assets ? loadQuickJSWasm(assets.wasmPath) : undefined;
    // Loading may fail before a standard-mode thread ever invokes Code mode.
    void wasm?.catch(() => {});
    super({
      ...(assets ? { workerUrl: assets.workerUrl, wasm } : {}),
      memoryLimitBytes: codemodeLimits.memoryLimitBytes,
      acquireWorker: () => {
        if (workers >= codemodeLimits.workers)
          throw new Error("Code mode 并发已满，请等待其他脚本完成后重试");
        workers++;
        return () => {
          workers--;
        };
      },
    });
  }

  override start(code: string, options: CodemodeRunOptions) {
    return super.start(code, {
      ...options,
      // Replaying a persisted call does not restart its host deadline.
      timeoutMs: Math.max(
        1,
        Math.min(
          options.timeoutMs ?? Infinity,
          options.startedAt + codemodeLimits.timeoutMs - Date.now(),
        ),
      ),
    });
  }
}

export function runtimeCodemode(sandbox: RuntimeCodemodeSandbox) {
  const extension = createCodemodeExtension({ sandbox, models: false });
  return {
    ...extension,
    // Deferred keeps legacy conversations in standard mode without a migration that rewrites work.
    tools: extension.tools!.map((tool) => ({
      ...tool,
      deferred: true as const,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const [input, api, context] = args;
        const images: (ImageContent | TextContent)[] = [];
        const agent = await api.agent(context);
        const model = agent.model && api.models.getModel(agent.model.provider, agent.model.modelId);
        const maximumImages = model?.inputLimits?.images?.maxPerMessage ?? 16;
        let imageCount = 0;
        const result = await tool.execute(input, api, context);
        // Use the admitted declaration, not today's registry or the shape of a valid JSON value.
        const run = await api.snapshot(CodemodeRunDoc, api.taskId, context);
        const structuredTools = new Set(
          run?.start?.tools.filter((tool) => tool.structured).map((tool) => tool.name),
        );
        // Read the durable nested results, including when upstream already committed its outcome
        // before a restart. Schema-less image results are intentionally text-only inside scripts.
        const calls =
          Predicate.isObject(result.details) && Array.isArray(result.details.calls)
            ? result.details.calls
            : [];
        const enrichedCalls = [];
        const computerImages: string[] = [];
        let computerFailure = false;
        let remainingPreview = 32_000;
        for (const call of calls) {
          if (!Predicate.isObject(call) || typeof call.id !== "number") continue;
          const nested = await api.snapshot(NestedCallDoc, api.taskId, `c${call.id}`, context);
          const value = nested?.result?.structuredOutput;
          if (call.name === "computer")
            computerImages.push(...computerImageDigests(nested?.result?.details));
          if (call.name === "computer" && nested?.result?.isError) computerFailure = true;
          const content = Array.isArray(value) ? value : [value];
          const structured = typeof call.name === "string" && structuredTools.has(call.name);
          const source = structured
            ? (JSON.stringify(
                call.name === "computer" &&
                  Predicate.isObject(value) &&
                  Predicate.isObject(value.image)
                  ? { ...value, image: { type: value.image.type, mimeType: value.image.mimeType } }
                  : value,
              ) ?? "")
            : typeof value === "string"
              ? value
              : Predicate.isObject(value) && !("type" in value)
                ? JSON.stringify(value)
                : content
                    .flatMap((part) =>
                      Predicate.isObject(part) &&
                      part.type === "text" &&
                      typeof part.text === "string"
                        ? [part.text]
                        : [],
                    )
                    .join("\n");
          const limit = Math.min(4000, remainingPreview);
          const text =
            source.length > limit && limit > 32
              ? `${source.slice(0, limit - 32)}\n[Output preview truncated]`
              : source.slice(0, limit);
          remainingPreview -= text.length;
          const details = nested?.result?.details;
          const detailsLength = details === undefined ? Infinity : JSON.stringify(details).length;
          const includeDetails = detailsLength <= Math.min(8000, remainingPreview);
          if (includeDetails) remainingPreview -= detailsLength;
          // History references survive the text/details preview budget; the artifact is loaded on demand.
          const change =
            Predicate.isObject(details) && Predicate.isObject(details.fileChange)
              ? details.fileChange
              : undefined;
          const fileChange =
            change &&
            typeof change.id === "string" &&
            change.id.length <= 128 &&
            typeof change.path === "string" &&
            typeof change.status === "string"
              ? { id: change.id, path: change.path.slice(0, 4096), status: change.status }
              : undefined;
          enrichedCalls.push({
            ...call,
            ...(nested?.taskId === undefined ? {} : { taskId: String(nested.taskId) }),
            parentTaskId: String(api.taskId),
            result: {
              content: text ? [{ type: "text" as const, text }] : [],
              ...(includeDetails && details !== undefined
                ? { details }
                : fileChange
                  ? { details: { fileChange } }
                  : {}),
            },
          });
          if (call.name !== "read") continue;
          if (!content.some((part) => Predicate.isObject(part) && part.type === "image")) continue;
          for (const part of content) {
            if (!Predicate.isObject(part)) continue;
            if (
              part.type === "image" &&
              typeof part.data === "string" &&
              typeof part.mimeType === "string"
            ) {
              if (imageCount++ < maximumImages)
                images.push({ type: "image", data: part.data, mimeType: part.mimeType });
            } else if (part.type === "text" && typeof part.text === "string")
              images.push({ type: "text", text: part.text });
          }
        }
        let deliveredImages = 0;
        const output = [...(result.output ?? []), ...images].filter(
          (part) => part.type !== "image" || deliveredImages++ < maximumImages,
        );
        const omittedImages =
          Math.max(0, imageCount - maximumImages) + Math.max(0, deliveredImages - maximumImages);
        return {
          ...result,
          ...(Predicate.isObject(result.details)
            ? {
                details: {
                  ...result.details,
                  calls: enrichedCalls,
                  ...(computerImages.length ? { computerImages } : {}),
                },
              }
            : {}),
          output: [
            ...output,
            ...(omittedImages
              ? [
                  {
                    type: "text" as const,
                    text: `Image limit reached; ${omittedImages} images omitted.`,
                  },
                ]
              : []),
            ...(result.isError
              ? [
                  {
                    type: "text" as const,
                    text: computerFailure
                      ? "computer 调用失败，请根据工具错误修正参数或重新观察。此前成功的动作不会撤销；不要盲目重放输入或发送。"
                      : "Code mode 执行失败。可重试，或在设置 → 应用 → 权限切换普通模式后发起新任务。",
                  },
                ]
              : []),
          ],
        };
      },
    })),
    sections: extension.sections!.map((section) => ({
      ...section,
      render: async (...args: Parameters<typeof section.render>) => {
        const [input, context] = args;
        const state = await input.read.snapshot(AgentModeDoc, input.conversationId, context);
        return state?.mode === "codemode" ? section.render(...args) : undefined;
      },
    })),
  };
}

/** Called only on new admission, or while creating a child in its parent's transaction. */
export async function configureAgentMode(tx: Tx, id: ConversationId, mode: AgentMode) {
  (await tx.doc(AgentModeDoc, id)).mode = mode;
  const agent = await tx.doc(AgentDoc, id);
  agent.modelTools = mode === "codemode" ? ["codemode"] : { remove: ["codemode"] };
}

export async function inheritAgentMode(tx: Tx, parent: ConversationId, child: ConversationId) {
  const state = await tx.doc(AgentModeDoc, parent);
  await configureAgentMode(tx, child, state.mode);
}

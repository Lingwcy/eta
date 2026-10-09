import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef } from "@eta/agent";
import { TitleDoc } from "../../agent/extension/title/task.ts";
import type { ThreadRuntime } from "../runtime/index.ts";

/** The document records the one admitted task, including failures and aborts, so later turns never rename it again. */
export async function startTitle(runtime: ThreadRuntime, model: ModelRef, operationId: string) {
  const page = await runtime.storage.scanSubmissions(
    { conversationId: runtime.conversation.id },
    2,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const first = page.items[0];
  if (
    page.next ||
    page.items.length !== 1 ||
    first?.type !== "input" ||
    first.entry === undefined ||
    String(first.id) !== operationId
  )
    return;
  const entry = first.entry;
  const created = await runtime.conversation.commit(async (tx) => {
    const state = await tx.doc(TitleDoc, runtime.conversation.id);
    if (state.taskId !== undefined) return;
    state.taskId = await tx.createTask(
      runtime.titleTask,
      { entry, model, sessionId: runtime.ref.metadata.id },
      { ownership: { kind: "conversation" }, background: true },
    );
    return true;
  }, BACKGROUND_CONTEXT);
  if (created && !runtime.recoveryRequired) runtime.harness.resume();
}

import type { ThreadMetadata } from "../../../shared/threads.ts";

export function canGenerateTitle(thread: ThreadMetadata) {
  return (
    thread.titleSource === "temporary" ||
    (thread.titleSource === undefined && thread.title === "新会话")
  );
}

export function applyInputTitle(thread: ThreadMetadata, input: string, automatic: boolean) {
  if (!automatic || thread.titleSource === "generated" || thread.titleSource === "manual")
    return thread;
  return {
    ...thread,
    title: thread.title === "新会话" ? input.slice(0, 80) : thread.title,
    titleSource: "temporary" as const,
  };
}

export function applyGeneratedTitle(thread: ThreadMetadata, title: string) {
  return thread.titleSource === "temporary"
    ? { ...thread, title, titleSource: "generated" as const }
    : thread;
}

export function applyManualTitle(thread: ThreadMetadata, title: string) {
  return { ...thread, title: title.trim(), titleSource: "manual" as const };
}

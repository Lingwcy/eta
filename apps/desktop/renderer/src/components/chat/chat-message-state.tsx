import { createContext, useContext, useState } from "react";

/** Expansion belongs to the transcript, so virtual rows may unmount without closing details. */
export const ChatMessageState = createContext<{
  id: string;
  expanded: Set<string>;
} | null>(null);

export function useMessageExpansion(part: string) {
  const state = useContext(ChatMessageState);
  const key = `${state?.id}:${part}`;
  const [open, setOpen] = useState(() => state?.expanded.has(key) ?? false);
  return [
    open,
    (value: boolean) => {
      if (value) state?.expanded.add(key);
      else state?.expanded.delete(key);
      setOpen(value);
    },
  ] as const;
}

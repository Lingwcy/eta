import type { ComponentProps } from "react";
import { Reveal } from "@/components/ui/reveal";
import { AgentThinking } from "./index";

/** Keep the status row's geometry stable across waiting, reasoning, and text streaming. */
export function ThinkingSlot({
  thinking,
}: {
  thinking: ComponentProps<typeof AgentThinking> | null;
}) {
  return (
    <div className="h-9 shrink-0 py-2">
      {thinking && (
        <Reveal>
          <AgentThinking {...thinking} />
        </Reveal>
      )}
    </div>
  );
}

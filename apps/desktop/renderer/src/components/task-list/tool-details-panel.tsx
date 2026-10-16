import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { SnapshotTool } from "@eta/core/agent/protocol";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
} from "@/components/ui/scroll-area";
import { ToolDetails } from "./tool-details";

/** The default preview has no scroll container, so wheel input reaches the conversation. */
export function ToolDetailsPanel({ tool, expanded }: { tool: SnapshotTool; expanded: boolean }) {
  useTranslation();
  if (!expanded) {
    return (
      <div className="h-30 overflow-clip pr-3">
        <ToolDetails tool={tool} />
      </div>
    );
  }
  return (
    <ScrollAreaRoot className="h-60">
      <ScrollAreaViewport
        aria-label={t("chat:toolDetailsPanel.argumentsAndResult", { toolName: tool.toolName })}
      >
        <ScrollAreaContent>
          <ToolDetails tool={tool} />
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar />
    </ScrollAreaRoot>
  );
}

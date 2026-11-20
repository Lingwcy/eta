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

/** Opening a tool always reveals its complete details in a height-limited scroll area. */
export function ToolDetailsPanel({
  tool,
  hideImages = false,
}: {
  tool: SnapshotTool;
  hideImages?: boolean;
}) {
  useTranslation();
  return (
    <ScrollAreaRoot className="max-h-60">
      <ScrollAreaViewport
        className="max-h-60"
        overscroll="auto"
        role="region"
        aria-label={t("chat:toolDetailsPanel.argumentsAndResult", { toolName: tool.toolName })}
      >
        <ScrollAreaContent>
          <ToolDetails tool={tool} hideImages={hideImages} />
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar />
    </ScrollAreaRoot>
  );
}

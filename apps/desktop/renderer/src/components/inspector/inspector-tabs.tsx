import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Github, FileDiff } from "lucide-react";

export type InspectorContent = "github" | "subagents" | "diff";
import { Tabs, TabsList, TabsTrigger, TabsPanel } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const ToolbarContext = createContext<HTMLDivElement | null>(null);

export function InspectorToolbar({ children }: { children: ReactNode }) {
  const target = useContext(ToolbarContext);
  return target ? createPortal(children, target) : null;
}

export function InspectorTabs({
  value,
  onChange,
  github,
  subagents,
  diff,
}: {
  value: InspectorContent;
  onChange: (value: InspectorContent) => void;
  github?: ReactNode;
  subagents?: ReactNode;
  diff?: ReactNode;
}) {
  useTranslation();
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const active =
    value === "github" && github
      ? "github"
      : value === "subagents" && subagents
        ? "subagents"
        : value === "diff" && diff
          ? "diff"
          : subagents
            ? "subagents"
            : github
              ? "github"
              : "diff";
  return (
    <Tabs
      value={active}
      onValueChange={(next) => {
        if (next === "github" || next === "subagents" || next === "diff") onChange(next);
      }}
      render={<div className="relative flex min-h-0 flex-1 flex-col" />}
    >
      <div
        className={cn(
          "flex h-8 shrink-0 items-center justify-between gap-1 px-2",
          active === "diff" && "absolute top-0 right-0 z-20",
        )}
      >
        <div ref={setToolbar} className="flex min-w-0 flex-1 items-center gap-0.5" />
        <TabsList
          aria-label={t("inspector:inspectorTabs.sidebarFeatures")}
          className="flex items-center gap-1"
        >
          {diff && (
            <TabsTrigger
              variant="inspector"
              value="diff"
              aria-label={t("inspector:inspectorTabs.diff")}
              title={t("inspector:inspectorTabs.diff")}
            >
              <FileDiff aria-hidden="true" />
            </TabsTrigger>
          )}
          {github && (
            <TabsTrigger variant="inspector" value="github" aria-label="GitHub" title="GitHub">
              <Github aria-hidden="true" />
            </TabsTrigger>
          )}
          {subagents && (
            <TabsTrigger
              variant="inspector"
              value="subagents"
              aria-label={t("inspector:inspectorTabs.subagents")}
              title={t("inspector:inspectorTabs.subagents")}
            >
              <Bot aria-hidden="true" />
            </TabsTrigger>
          )}
        </TabsList>
      </div>
      {diff && (
        <TabsPanel value="diff" keepMounted className="flex min-h-0 flex-1 flex-col">
          <ToolbarContext.Provider value={active === "diff" ? toolbar : null}>
            {diff}
          </ToolbarContext.Provider>
        </TabsPanel>
      )}
      {github && (
        <TabsPanel value="github" keepMounted className="flex min-h-0 flex-1 flex-col">
          <ToolbarContext.Provider value={active === "github" ? toolbar : null}>
            {github}
          </ToolbarContext.Provider>
        </TabsPanel>
      )}
      {subagents && (
        <TabsPanel value="subagents" keepMounted className="flex min-h-0 flex-1 flex-col">
          <ToolbarContext.Provider value={active === "subagents" ? toolbar : null}>
            {subagents}
          </ToolbarContext.Provider>
        </TabsPanel>
      )}
    </Tabs>
  );
}

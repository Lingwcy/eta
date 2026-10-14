import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Github } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsPanel } from "@/components/ui/tabs";

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
}: {
  value: "github" | "subagents";
  onChange: (value: "github" | "subagents") => void;
  github?: ReactNode;
  subagents?: ReactNode;
}) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const active =
    value === "github" && github
      ? "github"
      : value === "subagents" && subagents
        ? "subagents"
        : subagents
          ? "subagents"
          : "github";
  return (
    <Tabs
      value={active}
      onValueChange={(next) => {
        if (next === "github" || next === "subagents") onChange(next);
      }}
      render={<div className="flex min-h-0 flex-1 flex-col" />}
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-1 px-2">
        <div ref={setToolbar} className="flex min-w-0 flex-1 items-center gap-0.5" />
        <TabsList aria-label="右侧栏功能" className="flex items-center gap-1">
          {github && (
            <TabsTrigger variant="inspector" value="github" aria-label="GitHub" title="GitHub">
              <Github aria-hidden="true" />
            </TabsTrigger>
          )}
          {subagents && (
            <TabsTrigger
              variant="inspector"
              value="subagents"
              aria-label="子智能体"
              title="子智能体"
            >
              <Bot aria-hidden="true" />
            </TabsTrigger>
          )}
        </TabsList>
      </div>
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

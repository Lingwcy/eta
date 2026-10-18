import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { type ReactNode } from "react";
import { SquarePen, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Kbd } from "@/components/ui/kbd";

interface Props {
  children: ReactNode;
  archived: boolean;
  canCreate: boolean;
  search: ReactNode;
  onNew: () => void;
  recent?: boolean;
  onRecent?: () => void;
}
export function ProjectSidebar({
  children,
  archived,
  canCreate,
  search,
  onNew,
  recent = false,
  onRecent,
}: Props) {
  useTranslation();
  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#f8f8f8] px-2 pt-2 pb-2">
      <div className="flex items-center gap-1 pb-2">
        <div className="min-w-0 flex-1">
          <Button variant="ghost" size="row-compact" onClick={onNew} disabled={!canCreate}>
            <SquarePen size={19} aria-hidden="true" />
            <span className="min-w-0 truncate">{t("navigation:projectSidebar.newChat")}</span>
            <span className="ml-auto hidden shrink-0 whitespace-nowrap min-[1600px]:block">
              <Kbd>⌘ N</Kbd>
            </span>
          </Button>
        </div>
        {onRecent && (
          <Button
            variant={recent ? "info" : "ghost-muted"}
            size="icon-xs"
            aria-label={t("navigation:projectSidebar.recentChats")}
            aria-pressed={recent}
            title={t("navigation:projectSidebar.recentChats")}
            onClick={onRecent}
          >
            <Bell size={16} aria-hidden="true" />
          </Button>
        )}
        {search}
      </div>
      <div className="px-2 pt-2 pb-1.5 text-xs font-medium text-neutral-500">
        {recent
          ? t("navigation:projectSidebar.recentChats")
          : archived
            ? t("navigation:projectSidebar.archived")
            : t("navigation:projectSidebar.projects")}
      </div>
      <ScrollArea className="-mr-2 flex-1">
        <nav
          aria-label={
            archived
              ? t("navigation:projectSidebar.archivedChats")
              : t("navigation:projectSidebar.projectsAndChats")
          }
        >
          {children}
        </nav>
      </ScrollArea>
    </aside>
  );
}

import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, PauseCircle, Play, RotateCcw, Pencil, Trash2 } from "lucide-react";
import type { Schedule } from "@eta/core/shared/schedules";
import { Button } from "@/components/ui/button";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenuTrigger,
  menuPopupStyle,
} from "@/components/ui/context-menu";

function Content({ children, submenu = false }: { children: ReactNode; submenu?: boolean }) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        side={submenu ? "inline-end" : "bottom"}
        align={submenu ? "start" : "end"}
        sideOffset={submenu ? 12 : 4}
        alignOffset={submenu ? -5 : 0}
        collisionPadding={8}
        className="z-50"
      >
        <Menu.Popup className={menuPopupStyle}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function ScheduleMenu({
  plans,
  disabled,
  label,
  onAction,
}: {
  plans: readonly Schedule[];
  disabled: boolean;
  label: string;
  onAction: (plan: Schedule, action: "pause" | "resume" | "run" | "edit" | "delete") => void;
}) {
  useTranslation();
  const actions = (plan: Schedule) => (
    <>
      {plan.state !== "completed" && (
        <ContextMenuItem
          disabled={disabled}
          onClick={() => onAction(plan, plan.state === "active" ? "pause" : "resume")}
        >
          {plan.state === "active" ? <PauseCircle /> : <Play />}
          {plan.state === "active"
            ? t("schedules:scheduleMenu.pause")
            : t("schedules:scheduleMenu.resume")}
        </ContextMenuItem>
      )}
      <ContextMenuItem disabled={disabled} onClick={() => onAction(plan, "run")}>
        <RotateCcw />
        {t("schedules:scheduleMenu.runNow")}
      </ContextMenuItem>
      <ContextMenuItem disabled={disabled} onClick={() => onAction(plan, "edit")}>
        <Pencil />
        {t("schedules:scheduleMenu.edit")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={disabled} destructive onClick={() => onAction(plan, "delete")}>
        <Trash2 />
        {t("schedules:scheduleMenu.delete")}
      </ContextMenuItem>
    </>
  );
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={t("schedules:scheduleMenu.taskActionsFor", { label: label })}
          />
        }
      >
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Content>
        {plans.length === 1
          ? actions(plans[0])
          : plans.map((plan) => (
              <Menu.SubmenuRoot key={plan.id}>
                <ContextMenuSubmenuTrigger>
                  <span className="truncate">{plan.name}</span>
                </ContextMenuSubmenuTrigger>
                <Content submenu>{actions(plan)}</Content>
              </Menu.SubmenuRoot>
            ))}
      </Content>
    </Menu.Root>
  );
}

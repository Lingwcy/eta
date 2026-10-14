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
  const actions = (plan: Schedule) => (
    <>
      {plan.state !== "completed" && (
        <ContextMenuItem
          disabled={disabled}
          onClick={() => onAction(plan, plan.state === "active" ? "pause" : "resume")}
        >
          {plan.state === "active" ? <PauseCircle /> : <Play />}
          {plan.state === "active" ? "暂停" : "恢复"}
        </ContextMenuItem>
      )}
      <ContextMenuItem disabled={disabled} onClick={() => onAction(plan, "run")}>
        <RotateCcw />
        立即运行
      </ContextMenuItem>
      <ContextMenuItem disabled={disabled} onClick={() => onAction(plan, "edit")}>
        <Pencil />
        编辑
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={disabled} destructive onClick={() => onAction(plan, "delete")}>
        <Trash2 />
        删除
      </ContextMenuItem>
    </>
  );
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button variant="ghost-muted" size="icon-xs" aria-label={`${label}的任务操作`} />}
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

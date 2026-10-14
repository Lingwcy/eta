import { useId, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Local wall time, matching the once rule's conversion at form submission. */
export function ScheduleDatePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const timeId = useId();
  const [open, setOpen] = useState(false);
  const selected = new Date(`${value.split("T")[0]}T12:00:00`);
  const [month, setMonth] = useState(
    () => new Date(selected.getFullYear(), selected.getMonth(), 1),
  );
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const days = Array.from(
    { length: 42 },
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        aria-label="选择执行日期和时间"
        render={<Button variant="outline" size="row-sm" />}
      >
        <span className="flex-1">
          {selected.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}{" "}
          {value.split("T")[1]}
        </span>
        <CalendarDays size={15} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={5} className="z-50">
          <Popover.Popup
            aria-label="执行日期"
            className="w-64 max-w-[calc(100vw-32px)] rounded-xl border border-black/12 bg-white p-2 text-xs shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] outline-none"
          >
            <div className="mb-1 flex items-center justify-between">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="上个月"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              >
                <ChevronLeft size={14} />
              </Button>
              <span aria-live="polite">
                {month.getFullYear()}年{month.getMonth() + 1}月
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="下个月"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
                <span key={day} className="py-1 text-center text-neutral-400">
                  {day}
                </span>
              ))}
              {days.map((day) => (
                <div
                  key={dateKey(day)}
                  className={day.getMonth() !== month.getMonth() ? "opacity-40" : undefined}
                >
                  <Button
                    variant="ghost"
                    size="row-compact"
                    aria-label={dateKey(day)}
                    aria-pressed={dateKey(day) === value.split("T")[0]}
                    selected={dateKey(day) === value.split("T")[0]}
                    onClick={() => onChange(`${dateKey(day)}T${value.split("T")[1] ?? "09:00"}`)}
                  >
                    <span className="flex-1 text-center">{day.getDate()}</span>
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-neutral-100 pt-2">
              <label htmlFor={timeId} className="shrink-0 text-neutral-500">
                时间
              </label>
              <Input
                id={timeId}
                aria-label="执行时刻"
                variant="compact"
                inputMode="numeric"
                placeholder="09:00"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                required
                value={value.split("T")[1] ?? ""}
                onChange={(event) => onChange(`${value.split("T")[0]}T${event.target.value}`)}
              />
              <Button size="compact" onClick={() => setOpen(false)}>
                确定
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

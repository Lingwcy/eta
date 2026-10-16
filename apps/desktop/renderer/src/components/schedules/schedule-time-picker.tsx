import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Clock3 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

export function ScheduleTimePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const hourRef = useRef<HTMLButtonElement>(null);
  const minuteRef = useRef<HTMLButtonElement>(null);
  const [hour, minute] = value.split(":");
  useEffect(() => {
    if (!open) return;
    hourRef.current?.scrollIntoView?.({ block: "nearest" });
    minuteRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={disabled}
        aria-label={t("schedules:scheduleTimePicker.chooseARunTime")}
        render={<Button variant="outline" size="row-compact" />}
      >
        <span className="flex-1">{value}</span>
        <Clock3 size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={5} className="z-50">
          <Popover.Popup
            aria-label={t("schedules:scheduleTimePicker.runTimePicker")}
            className="w-44 rounded-xl border border-black/12 bg-white p-2 text-xs shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] outline-none"
          >
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 text-center text-neutral-400">
                  {t("schedules:scheduleTimePicker.hour")}
                </p>
                <ScrollArea
                  className="h-40"
                  gutter="overlay"
                  aria-label={t("schedules:scheduleTimePicker.hours")}
                >
                  {hours.map((item) => (
                    <Button
                      key={item}
                      ref={item === hour ? hourRef : undefined}
                      variant="ghost"
                      size="row-compact"
                      selected={item === hour}
                      disabled={disabled}
                      aria-pressed={item === hour}
                      aria-label={t("schedules:scheduleTimePicker.hours2", {
                        count: Number(item),
                        value: item,
                      })}
                      onClick={() => onChange(`${item}:${minute}`)}
                    >
                      <span className="flex-1 text-center">{item}</span>
                    </Button>
                  ))}
                </ScrollArea>
              </div>
              <div>
                <p className="mb-1 text-center text-neutral-400">
                  {t("schedules:scheduleTimePicker.minute")}
                </p>
                <ScrollArea
                  className="h-40"
                  gutter="overlay"
                  aria-label={t("schedules:scheduleTimePicker.minutes")}
                >
                  {minutes.map((item) => (
                    <Button
                      key={item}
                      ref={item === minute ? minuteRef : undefined}
                      variant="ghost"
                      size="row-compact"
                      selected={item === minute}
                      disabled={disabled}
                      aria-pressed={item === minute}
                      aria-label={t("schedules:scheduleTimePicker.minutes2", {
                        count: Number(item),
                        value: item,
                      })}
                      onClick={() => onChange(`${hour}:${item}`)}
                    >
                      <span className="flex-1 text-center">{item}</span>
                    </Button>
                  ))}
                </ScrollArea>
              </div>
            </div>
            <div className="mt-2 flex justify-end border-t border-neutral-100 pt-2">
              <Button
                size="compact"
                aria-label={t("schedules:scheduleTimePicker.confirmRunTime")}
                onClick={() => setOpen(false)}
              >
                {t("schedules:scheduleTimePicker.confirm")}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

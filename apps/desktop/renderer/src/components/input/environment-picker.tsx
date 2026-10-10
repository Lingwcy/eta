import { Cloud, Laptop, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

export function EnvironmentPicker({
  cloud,
  connected,
  disabled,
  onChange,
  onSettings,
}: {
  cloud: boolean;
  connected: boolean;
  disabled: boolean;
  onChange: (cloud: boolean) => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={<Button variant="ghost" size="pill" selected={open} />}
        aria-label="选择执行位置"
      >
        {cloud ? <Cloud size={18} /> : <Laptop size={18} />}
        {cloud ? "Bot" : "此计算机"}
      </PopoverTrigger>
      <PopoverContent variant="menu" aria-label="选择执行位置">
        <Button
          variant="menu"
          size="menu-item"
          onClick={() => {
            onChange(false);
            setOpen(false);
          }}
        >
          <Laptop size={17} />
          此计算机{!cloud && <Check size={16} />}
        </Button>
        <Button
          variant="menu"
          size="menu-item"
          disabled={!connected}
          onClick={() => {
            onChange(true);
            setOpen(false);
          }}
        >
          <Cloud size={17} />
          Bot{cloud && <Check size={16} />}
        </Button>
        {!connected && (
          <Button
            variant="menu"
            size="menu-item"
            onClick={() => {
              onSettings();
              setOpen(false);
            }}
          >
            连接 Bot…
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

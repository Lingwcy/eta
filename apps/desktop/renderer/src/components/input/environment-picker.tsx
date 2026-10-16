import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
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
  useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={<Button variant="ghost" size="pill" selected={open} />}
        aria-label={t("chat:environmentPicker.chooseWhereToRun")}
      >
        {cloud ? <Cloud size={18} /> : <Laptop size={18} />}
        {cloud ? "Bot" : t("chat:environmentPicker.thisComputer")}
      </PopoverTrigger>
      <PopoverContent variant="menu" aria-label={t("chat:environmentPicker.chooseWhereToRun")}>
        <Button
          variant="menu"
          size="menu-item"
          onClick={() => {
            onChange(false);
            setOpen(false);
          }}
        >
          <Laptop size={17} />
          {t("chat:environmentPicker.thisComputer")}
          {!cloud && <Check size={16} />}
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
            {t("chat:environmentPicker.connectToBot")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

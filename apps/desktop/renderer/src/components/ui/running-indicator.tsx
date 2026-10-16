import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
/** A static activity ring keeps long-running sidebar items from continuously repainting. */
export function RunningIndicator() {
  useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center">
      <span
        aria-hidden="true"
        className="size-3.5 rounded-full border-2 border-neutral-300 border-t-neutral-500"
      />
      <span className="sr-only">{t("common:runningIndicator.running")}</span>
    </span>
  );
}

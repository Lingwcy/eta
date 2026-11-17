import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Spinner } from "./spinner";

/** Controls whether sidebar/list running spinners animate; hidden containers set this to false. */
export const RunningAnimation = createContext(true);

/** Lightweight GPU-composited activity ring that pauses when hidden or under reduced motion. */
export function RunningIndicator({ active }: { active?: boolean }) {
  useTranslation();
  const visible = useContext(RunningAnimation);
  return (
    <span className="inline-flex shrink-0 items-center">
      <Spinner size="sm" active={active ?? visible} />
      <span className="sr-only">{t("common:runningIndicator.running")}</span>
    </span>
  );
}

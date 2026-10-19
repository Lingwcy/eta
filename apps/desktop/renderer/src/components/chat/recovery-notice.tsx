import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
export function RecoveryNotice({
  busy,
  blocked,
  onResume,
  onStop,
}: {
  busy: boolean;
  blocked: boolean;
  onResume: () => void;
  onStop: () => void;
}) {
  useTranslation();
  return (
    <Alert tone="warning">
      <p>{t("chat:recoveryNotice.anUnfinishedTaskWasFoundResumingMay")}</p>
      <div className="mt-2.5 flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || blocked} onClick={onResume}>
          {t("chat:recoveryNotice.resumeTask")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onStop}>
          {t("chat:recoveryNotice.stopTask")}
        </Button>
      </div>
    </Alert>
  );
}

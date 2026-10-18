import { Trans, useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { TerminalSquare } from "lucide-react";

export function ChatWelcome({
  projectName,
  connecting,
}: {
  projectName?: string;
  connecting: boolean;
}) {
  useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center pt-8 pb-11 text-center">
      <TerminalSquare
        className="mb-4 text-neutral-300"
        size={38}
        strokeWidth={1.4}
        aria-hidden="true"
      />
      <h2 className="text-[19px]/normal font-normal tracking-tight text-balance min-[901px]:text-[clamp(19px,1.5vw,21px)]">
        {projectName ? (
          <Trans
            ns="chat"
            i18nKey="chatWelcome.project"
            values={{ projectName }}
            components={{
              project: (
                <span className="underline decoration-neutral-300 decoration-dotted decoration-1 underline-offset-4" />
              ),
            }}
          />
        ) : (
          t("chat:chatWelcome.whatWouldYouLikeToBuildToday")
        )}
      </h2>
      {connecting && (
        <output className="mt-2 text-xs text-neutral-400">
          {t("chat:chatWelcome.preparingTheAgent")}
        </output>
      )}
    </div>
  );
}

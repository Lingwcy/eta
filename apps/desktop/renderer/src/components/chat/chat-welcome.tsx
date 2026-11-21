import { useState } from "react";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { EtaWelcomeLogo } from "./eta-welcome-logo";

export const welcomeGreetingKeys = [
  "chat:chatWelcome.greeting.followYourLead",
  "chat:chatWelcome.greeting.letsGetStarted",
  "chat:chatWelcome.greeting.howCanIHelp",
  "chat:chatWelcome.greeting.whatsNext",
  "chat:chatWelcome.greeting.readyWhenYouAre",
  "chat:chatWelcome.greeting.newIdea",
  "chat:chatWelcome.greeting.createTogether",
  "chat:chatWelcome.greeting.whereToBegin",
] as const;

export type WelcomeGreetingKey = (typeof welcomeGreetingKeys)[number];

let lastGreetingKey: WelcomeGreetingKey | undefined;

/** Picks a welcome greeting key at random, avoiding an immediate back-to-back repeat. */
export function selectWelcomeGreetingKey(options?: {
  exclude?: WelcomeGreetingKey;
  random?: () => number;
}): WelcomeGreetingKey {
  const candidates =
    options?.exclude && welcomeGreetingKeys.length > 1
      ? welcomeGreetingKeys.filter((key) => key !== options.exclude)
      : welcomeGreetingKeys;
  const raw = (options?.random ?? Math.random)();
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999999) : 0;
  return candidates[Math.floor(unit * candidates.length)]!;
}

function nextWelcomeGreetingKey(): WelcomeGreetingKey {
  const selected = selectWelcomeGreetingKey({ exclude: lastGreetingKey });
  lastGreetingKey = selected;
  return selected;
}

export function ChatWelcome({ connecting }: { connecting: boolean }) {
  useTranslation();
  const [greetingKey] = useState(nextWelcomeGreetingKey);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pt-8 pb-12 text-center">
      <EtaWelcomeLogo className="mb-6" />
      <h2 className="text-[22px]/snug font-normal tracking-tight text-balance text-foreground min-[901px]:text-[clamp(23px,1.9vw,27px)]">
        {t(greetingKey)}
      </h2>
      {connecting && (
        <output className="mt-2.5 text-xs text-subtle">
          {t("chat:chatWelcome.preparingTheAgent")}
        </output>
      )}
    </div>
  );
}

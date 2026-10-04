import { Bot } from "lucide-react";
import { providerLogoUrl } from "../settings/authentication/provider-logo-assets";

/** Reuses the settings artwork in the picker's monochrome treatment. */
export function ProviderMark({ id }: { id: string }) {
  const src = providerLogoUrl(id);
  return src ? (
    <img src={src} alt="" className="size-full object-contain grayscale" draggable={false} />
  ) : (
    <Bot className="size-full" aria-hidden="true" />
  );
}

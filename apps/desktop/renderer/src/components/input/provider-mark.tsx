import { Bot } from "lucide-react";
import { providerLogoUrl } from "../settings/authentication/provider-logo-assets";

/** The picker is already monochrome; only these marks invert, not account artwork. */
export function ProviderMark({ id }: { id: string }) {
  const src = providerLogoUrl(id);
  return src ? (
    <img
      src={src}
      alt=""
      className="size-full object-contain grayscale dark:invert"
      draggable={false}
    />
  ) : (
    <Bot className="size-full" aria-hidden="true" />
  );
}

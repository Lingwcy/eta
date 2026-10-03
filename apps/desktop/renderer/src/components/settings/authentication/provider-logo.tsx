import { Avatar } from "@/components/ui/avatar";
import { providerLogoUrl } from "./provider-logo-assets";

export function ProviderLogo({ id, name }: { id: string; name: string }) {
  return (
    <Avatar
      label={name}
      src={providerLogoUrl(id)}
      fallback={
        name
          .replace(/[^a-zA-Z]/g, "")
          .slice(0, 2)
          .toUpperCase() || "AI"
      }
      variant="brand"
    />
  );
}

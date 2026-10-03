import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
export function Avatar({
  label,
  fallback,
  src,
}: {
  label: string;
  fallback: string;
  src?: string;
}) {
  return (
    <BaseAvatar.Root
      aria-label={label}
      className="grid size-7 shrink-0 place-items-center rounded-full bg-neutral-50 text-neutral-600"
    >
      {src && <BaseAvatar.Image src={src} alt={label} className="size-full object-contain" />}
      <BaseAvatar.Fallback className="font-serif text-2xl italic">{fallback}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}

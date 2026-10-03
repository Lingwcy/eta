import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
export function Avatar({ label, fallback }: { label: string; fallback: string }) {
  return (
    <BaseAvatar.Root
      aria-label={label}
      className="grid size-7 shrink-0 place-items-center rounded-full bg-neutral-50 text-neutral-600"
    >
      <BaseAvatar.Fallback className="font-serif text-2xl italic">{fallback}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}

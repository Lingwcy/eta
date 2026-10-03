import { Avatar as BaseAvatar } from "@base-ui/react/avatar";

const variants = {
  avatar: {
    root: "grid size-7 shrink-0 place-items-center rounded-full bg-neutral-50 text-neutral-600",
    image: "size-full object-contain",
    fallback: "font-serif text-2xl italic",
  },
  brand: {
    root: "grid size-10 shrink-0 place-items-center rounded-xl border border-neutral-200/60 bg-white text-neutral-600",
    image: "size-6 object-contain",
    fallback: "text-sm font-semibold",
  },
};

export function Avatar({
  label,
  fallback,
  src,
  variant = "avatar",
}: {
  label: string;
  fallback: string;
  src?: string;
  variant?: keyof typeof variants;
}) {
  const styles = variants[variant];
  return (
    <BaseAvatar.Root aria-label={label} className={styles.root}>
      {src && <BaseAvatar.Image src={src} alt={label} className={styles.image} />}
      <BaseAvatar.Fallback className={styles.fallback}>{fallback}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}

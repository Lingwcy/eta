/** A static activity ring keeps long-running sidebar items from continuously repainting. */
export function RunningIndicator() {
  return (
    <span className="inline-flex shrink-0 items-center">
      <span
        aria-hidden="true"
        className="size-3.5 rounded-full border-2 border-neutral-300 border-t-neutral-500"
      />
      <span className="sr-only">正在运行</span>
    </span>
  );
}

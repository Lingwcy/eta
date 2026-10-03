import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/utils";

/** A content-sized text control; Chromium handles growth without layout effects. */
export function Textarea({ className, render, ...props }: useRender.ComponentProps<"textarea">) {
  return useRender({
    defaultTagName: "textarea",
    render,
    props: mergeProps<"textarea">(
      {
        className: cn(
          "block max-h-50 min-h-12 w-full resize-none border-0 bg-transparent p-0 text-sm/6 text-neutral-800 outline-none [field-sizing:content] placeholder:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        ),
      },
      props,
    ),
  });
}

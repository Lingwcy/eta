import { useMemo, useRef } from "react";
import { DEFAULT_VIRTUAL_FILE_METRICS, parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";

export type DiffLayout = "unified" | "split";
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_PATCH_LINES = 20_000;
const metrics = { ...DEFAULT_VIRTUAL_FILE_METRICS, paddingTop: 0 };

/** Only a selected, bounded patch reaches Pierre; no editor or historical file loader is installed. */
export function DiffPreview({
  patch,
  layout,
  location,
  positions,
}: {
  patch: string;
  layout: DiffLayout;
  location: string;
  positions: Map<string, number>;
}) {
  useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const restored = useRef<string | undefined>(undefined);
  const parsed = useMemo(() => {
    if (patch.length > MAX_PATCH_BYTES || new TextEncoder().encode(patch).length > MAX_PATCH_BYTES)
      return "too-large" as const;
    if ((patch.match(/\n/g)?.length ?? 0) > MAX_PATCH_LINES) return "too-large" as const;
    try {
      const patches = parsePatchFiles(patch);
      if (patches.length !== 1 || patches[0]?.files.length !== 1) return "invalid" as const;
      return patches[0].files[0]!;
    } catch {
      return "invalid" as const;
    }
  }, [patch]);
  const options = useMemo(
    () => ({
      diffStyle: layout,
      themeType: "system" as const,
      preferredHighlighter: "shiki-js" as const,
      disableFileHeader: true,
      overflow: "scroll" as const,
      hunkSeparators: "line-info" as const,
      tokenizeMaxLineLength: 2000,
      tokenizeMaxLength: 200_000,
      maxLineDiffLength: 2000,
      unsafeCSS:
        ":host { --diffs-font-size: 12px; --diffs-line-height: 20px; } [data-code] { padding-top: 0; }",
      onPostRender: () => {
        if (restored.current === location) return;
        const scroller = container.current?.firstElementChild;
        if (!(scroller instanceof HTMLElement)) return;
        scroller.scrollTop = positions.get(location) ?? 0;
        restored.current = location;
      },
    }),
    [layout, location, positions],
  );
  if (parsed === "too-large" || parsed === "invalid")
    return (
      <p role="status" className="p-3 text-xs text-neutral-500">
        {parsed === "too-large" ? t("diff:reason.too-large") : t("diff:invalidPatch")}
      </p>
    );
  if (parsed.hunks.length === 0)
    return (
      <p role="status" className="p-3 text-xs text-neutral-500">
        {t("diff:noDifference")}
      </p>
    );
  return (
    <div
      ref={container}
      role="region"
      aria-label={t("diff:preview")}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onScrollCapture={(event) => {
        if (event.target !== container.current?.firstElementChild) return;
        const scroller = event.target;
        if (!(scroller instanceof HTMLElement)) return;
        if (!positions.has(location) && positions.size >= 100)
          positions.delete(positions.keys().next().value!);
        positions.set(location, scroller.scrollTop);
      }}
    >
      <Virtualizer
        className="min-h-0 min-w-0 flex-1 overflow-auto"
        config={{ overscrollSize: 500 }}
      >
        <FileDiff fileDiff={parsed} options={options} metrics={metrics} disableWorkerPool />
      </Virtualizer>
    </div>
  );
}

import { describeError, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t, currentFormatLocale } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Folder, ListTree, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { StorageReport, StorageTarget } from "../../../../src/shared/storage.ts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ToastNotice } from "@/components/ui/toast";
import { SearchInput } from "@/components/ui/search-input";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
} from "@/components/ui/scroll-area";

const sizes = () => new Intl.NumberFormat(currentFormatLocale(), { maximumFractionDigits: 1 });
function bytes(value: number | null) {
  if (value === null) return t("settings:storageSettings.cannotCalculate");
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit =
    value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return `${sizes().format(value / 1024 ** unit)} ${units[unit]}`;
}
const batchSize = 30;

export function StorageSettings({ active }: { active: boolean }) {
  useTranslation();
  const [report, setReport] = useState<StorageReport>();
  const [error, setError] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("size");
  const [visibleCount, setVisibleCount] = useState(batchSize);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setBusy(true);
    setError(undefined);
    void window.eta
      .storage()
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(describeError(error, String(error)));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, revision]);
  useEffect(() => {
    setVisibleCount(batchSize);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [query, sort, report]);
  const reveal = async (target: StorageTarget) => {
    setError(undefined);
    try {
      await window.eta.revealStorage(target);
    } catch (error) {
      setError(describeError(error, String(error)));
    }
  };
  const finder = navigator.userAgent.includes("Mac")
    ? t("settings:storageSettings.showInFinder")
    : navigator.userAgent.includes("Windows")
      ? t("settings:storageSettings.showInFileExplorer")
      : t("settings:storageSettings.showInFileManager");
  const sessions = useMemo(
    () =>
      (report?.sessions ?? [])
        .filter((session) =>
          `${session.title} ${session.project ?? ""}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) =>
          sort === "name" ? a.title.localeCompare(b.title) : (b.bytes ?? -1) - (a.bytes ?? -1),
        ),
    [report, query, sort],
  );
  return (
    <div className="space-y-4">
      <ToastNotice message={error} />
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-neutral-700">
          {t("settings:storageSettings.sessionStorage")}
        </h2>
        <span
          className="text-lg font-semibold tabular-nums text-neutral-800"
          title={
            report?.issues.length
              ? t("settings:storageSettings.onlyIncludesSessionFilesThatCouldBe")
              : undefined
          }
        >
          {report
            ? bytes(report.sessionBytes)
            : busy
              ? t("settings:storageSettings.calculating")
              : "—"}
        </span>
        <span className="flex-1 text-xs text-neutral-400">
          {report && t("settings:storageSettings.sessions", { count: report.sessions.length })}
        </span>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          disabled={busy}
          aria-label={t("settings:storageSettings.refreshSessionStorage")}
          title={t("settings:storageSettings.refresh")}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {report && (
        <div className="space-y-1">
          {[
            {
              label: t("settings:storageSettings.sessionDirectory"),
              path: report.paths.sessions,
              icon: Folder,
              target: { kind: "sessions" } as const,
            },
            {
              label: t("settings:storageSettings.modelConfiguration"),
              path: report.paths.modelConfiguration,
              icon: SlidersHorizontal,
              target: { kind: "configuration", id: "settings.json" } as const,
            },
            {
              label: "Catalog",
              path: report.paths.catalog,
              icon: ListTree,
              target: { kind: "configuration", id: "catalog.json" } as const,
            },
          ].map(({ label, path, icon: Icon, target }) => (
            <button
              key={label}
              type="button"
              title={`${path}\n${finder}`}
              onClick={() => void reveal(target)}
              className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-300"
            >
              <Icon size={14} className="shrink-0 text-neutral-400" />
              <span className="w-16 shrink-0 text-neutral-600">{label}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-400">{path}</span>
              <ArrowUpRight
                size={12}
                className="shrink-0 text-neutral-400 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="flex items-center gap-2 border-b border-neutral-100 p-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              placeholder={t("settings:storageSettings.searchSessionsOrProjects")}
              aria-label={t("settings:storageSettings.searchLocalSessions")}
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <Select
            value={sort}
            options={[
              { value: "size", label: t("settings:storageSettings.size") },
              { value: "name", label: t("settings:storageSettings.name") },
            ]}
            label={t("settings:storageSettings.sortSessions")}
            size="compact"
            variant="menu"
            onValueChange={setSort}
          />
        </div>
        <ScrollAreaRoot className="h-[min(420px,50vh)]">
          <ScrollAreaViewport
            ref={viewport}
            onScroll={(event) => {
              const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
              if (scrollHeight - scrollTop - clientHeight < 120)
                setVisibleCount((count) => Math.min(count + batchSize, sessions.length));
            }}
          >
            <ScrollAreaContent>
              {sessions.slice(0, visibleCount).map((session) => (
                <button
                  key={session.path}
                  type="button"
                  disabled={session.bytes === null}
                  title={finder}
                  aria-label={t("settings:storageSettings.revealSession", {
                    action: finder,
                    title: session.title || t("settings:storageSettings.unnamedSession"),
                  })}
                  onClick={() => void reveal({ kind: "session", id: session.id })}
                  className="flex w-full cursor-pointer items-center gap-4 border-b border-neutral-100 px-3 py-2.5 text-left outline-none last:border-0 hover:bg-neutral-50 focus-visible:bg-neutral-100 disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-neutral-800">
                      {session.title || t("settings:storageSettings.unnamedSession")}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-neutral-400">
                      {session.project ?? t("settings:storageSettings.noProject")}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                    {bytes(session.bytes)}
                  </span>
                </button>
              ))}
              {!sessions.length && (
                <p className="py-12 text-center text-xs text-neutral-400">
                  {busy && !report
                    ? t("settings:storageSettings.readingSessions")
                    : t("settings:storageSettings.noMatchingSessions")}
                </p>
              )}
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar />
        </ScrollAreaRoot>
      </div>
    </div>
  );
}

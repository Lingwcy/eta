import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Folder, ListTree, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { StorageReport, StorageTarget } from "../../../../src/main/storage/types.ts";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SearchInput } from "@/components/ui/search-input";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
} from "@/components/ui/scroll-area";

const sizes = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
function bytes(value: number | null) {
  if (value === null) return "无法统计";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit =
    value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return `${sizes.format(value / 1024 ** unit)} ${units[unit]}`;
}
const batchSize = 30;

export function StorageSettings({ active }: { active: boolean }) {
  const [report, setReport] = useState<StorageReport>();
  const [error, setError] = useState<string>();
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
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
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
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const finder = navigator.userAgent.includes("Mac")
    ? "在 Finder 中查看"
    : navigator.userAgent.includes("Windows")
      ? "在资源管理器中查看"
      : "在文件管理器中查看";
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
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-neutral-700">会话占用</h2>
        <span
          className="text-lg font-semibold tabular-nums text-neutral-800"
          title={report?.issues.length ? "仅计入成功读取的会话文件" : undefined}
        >
          {report ? bytes(report.sessionBytes) : busy ? "统计中…" : "—"}
        </span>
        <span className="flex-1 text-xs text-neutral-400">
          {report && `${report.sessions.length} 个会话`}
        </span>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          disabled={busy}
          aria-label="刷新会话占用"
          title="刷新"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {report && (
        <div className="space-y-1">
          {[
            {
              label: "会话目录",
              path: report.paths.sessions,
              icon: Folder,
              target: { kind: "sessions" } as const,
            },
            {
              label: "模型配置",
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
              placeholder="搜索会话或项目"
              aria-label="搜索本地会话"
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <select
            aria-label="会话排序"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="cursor-pointer rounded-md bg-transparent px-2 py-1.5 text-xs text-neutral-600 outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
          >
            <option value="size">占用大小</option>
            <option value="name">名称</option>
          </select>
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
                  aria-label={`${finder}：${session.title || "未命名会话"}`}
                  onClick={() => void reveal({ kind: "session", id: session.id })}
                  className="flex w-full cursor-pointer items-center gap-4 border-b border-neutral-100 px-3 py-2.5 text-left outline-none last:border-0 hover:bg-neutral-50 focus-visible:bg-neutral-100 disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-neutral-800">
                      {session.title || "未命名会话"}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-neutral-400">
                      {session.project ?? "未关联项目"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                    {bytes(session.bytes)}
                  </span>
                </button>
              ))}
              {!sessions.length && (
                <p className="py-12 text-center text-xs text-neutral-400">
                  {busy && !report ? "正在读取会话…" : "没有匹配的会话"}
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

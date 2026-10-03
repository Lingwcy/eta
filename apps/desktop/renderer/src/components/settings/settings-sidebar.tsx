import { SearchInput } from "@/components/ui/search-input";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { settingsGroups } from "./settings-categories";

export function SettingsSidebar({
  query,
  onQuery,
  onClose,
}: {
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  const search = query.trim().toLocaleLowerCase();
  return (
    <aside className="flex w-[180px] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#fafafa] px-2 pt-3 pb-2 min-[701px]:w-[210px] min-[901px]:w-[236px] min-[1600px]:w-[270px]">
      <h1 className="px-2 pb-4 text-lg font-semibold">设置</h1>
      <div className="mb-3">
        <SearchInput
          aria-label="搜索设置分类"
          placeholder="搜索"
          value={query}
          onValueChange={onQuery}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <TabsList aria-label="设置分类" activateOnFocus={false} className="flex flex-col">
          {settingsGroups.map((group) => {
            const items = group.items.filter(
              (item) => !search || item.label.toLocaleLowerCase().includes(search),
            );
            if (!items.length) return null;
            return (
              <div key={group.label} className="mb-5">
                <h2 className="px-2 pt-1 pb-2 text-[13px] font-medium text-neutral-500">
                  {group.label}
                </h2>
                {items.map((item) => (
                  <TabsTrigger key={item.id} value={item.id}>
                    <item.icon size={16} aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </TabsTrigger>
                ))}
              </div>
            );
          })}
        </TabsList>
        {search &&
          !settingsGroups.some((group) =>
            group.items.some((item) => item.label.toLocaleLowerCase().includes(search)),
          ) && <p className="px-2 py-4 text-xs text-neutral-400">没有匹配的设置分类</p>}
      </div>
      <Button variant="ghost-muted" size="row-sm" onClick={onClose}>
        返回聊天
      </Button>
    </aside>
  );
}

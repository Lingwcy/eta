import { useState } from "react";
import { FolderClosed, SquarePen } from "lucide-react";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { RunningIndicator } from "@/components/ui/running-indicator";
import { searchThreads } from "./search-threads";

import type { SearchDialogProps } from "./search-dialog-props";

export function ThreadSearchContent(props: SearchDialogProps & { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const matches = searchThreads(props.library, query, props.archived);
  const chats = (query.trim() ? matches : matches.slice(0, 9)).map(({ thread, project }) => ({
    id: thread.id,
    label: thread.title || "新聊天",
    project,
    kind: "chat",
  }));
  const actions = [
    {
      id: "new",
      label: "新聊天",
      kind: "action",
      icon: SquarePen,
      shortcut: "⌘N",
      disabled: !props.canCreate,
      run: props.onNew,
    },
    {
      id: "choose",
      label: "打开文件夹",
      kind: "action",
      icon: FolderClosed,
      shortcut: "⌘O",
      disabled: props.busy,
      run: props.onChoose,
    },
  ].filter((action) => !query.trim() || action.label.includes(query.trim()));
  const groups = [
    { label: props.archived ? "已归档聊天" : "聊天", items: chats },
    { label: "快捷操作", items: actions },
  ];
  const choose = (action: () => void) => {
    props.onClose();
    action();
  };
  return (
    <DialogContent
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.ctrlKey && /^[1-9]$/.test(event.key)) {
          const chat = chats[Number(event.key) - 1];
          if (chat) {
            event.preventDefault();
            event.stopPropagation();
            choose(() => props.onSelect(chat.id));
          }
        }
        if (event.metaKey || event.ctrlKey) {
          const key = event.key.toLowerCase();
          if (key === "n" || key === "o") {
            event.preventDefault();
            event.stopPropagation();
            if (key === "n" && props.canCreate) choose(props.onNew);
            if (key === "o" && !props.busy) choose(props.onChoose);
          }
        }
      }}
    >
      <DialogTitle className="sr-only">搜索聊天</DialogTitle>
      <Command
        items={groups}
        mode="none"
        inline
        open
        autoHighlight="always"
        value={query}
        onValueChange={setQuery}
        itemToStringValue={(item) => item.label}
      >
        <CommandInput aria-label="搜索聊天" placeholder="搜索聊天" />
        <CommandList>
          <CommandGroup>
            <CommandGroupLabel>{props.archived ? "已归档聊天" : "聊天"}</CommandGroupLabel>
            {chats.map((chat, index) => (
              <CommandItem
                key={chat.id}
                value={chat}
                onClick={() => choose(() => props.onSelect(chat.id))}
              >
                <span className="w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{chat.label}</span>
                {props.runningThreadIds.has(chat.id) && <RunningIndicator />}
                <span className="max-w-28 truncate text-[13px] text-neutral-400">
                  {chat.project}
                </span>
                {index < 9 && <Kbd variant="badge">⌃{index + 1}</Kbd>}
              </CommandItem>
            ))}
            {!chats.length && (
              <p className="px-6 py-3 text-sm text-neutral-400">
                {query.trim() ? "没有找到匹配的聊天" : "没有聊天记录"}
              </p>
            )}
          </CommandGroup>
          {actions.length > 0 && (
            <CommandGroup>
              <CommandGroupLabel>快捷操作</CommandGroupLabel>
              {actions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={action}
                  disabled={action.disabled}
                  onClick={() => choose(action.run)}
                >
                  <action.icon size={16} aria-hidden="true" />
                  <span className="flex-1">{action.label}</span>
                  <Kbd variant="badge">{action.shortcut}</Kbd>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </DialogContent>
  );
}

import { threadTitle } from "@/i18n/thread-title";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { ThreadContextMenu } from "../threads/thread-actions";
import { useMemo, useState } from "react";
import { Clock, FolderClosed, SquarePen, BookOpen } from "lucide-react";
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
import { ThreadItemStatus } from "./thread-item-status";
import { searchThreads } from "./search-threads";

import type { SearchDialogProps } from "./search-dialog-props";

export function ThreadSearchContent(props: SearchDialogProps & { onClose: () => void }) {
  useTranslation();
  const [query, setQuery] = useState("");
  const worktrees = useMemo(
    () =>
      new Set(
        props.library?.workspaces
          .filter((workspace) => workspace.kind === "worktree")
          .map((workspace) => workspace.id),
      ),
    [props.library],
  );
  const matches = searchThreads(props.library, query, props.archived);
  const chats = (query.trim() ? matches : matches.slice(0, 9)).map(({ thread, project }) => ({
    id: thread.id,
    label: threadTitle(thread),
    project,
    kind: "chat",
    worktree: worktrees.has(thread.workspaceId),
  }));
  const actionSearch = query.trim().toLocaleLowerCase();
  const actions = [
    ...(props.onSchedules
      ? [
          {
            id: "schedules",
            label: t("navigation:threadSearchContent.scheduledTasks"),
            kind: "action",
            icon: Clock,
            shortcut: "",
            disabled: props.busy,
            run: props.onSchedules,
          },
        ]
      : []),
    {
      id: "skills",
      label: t("navigation:threadSearchContent.skillSettings"),
      kind: "action",
      icon: BookOpen,
      shortcut: "",
      disabled: props.busy,
      run: props.onSkills,
    },
    {
      id: "new",
      label: t("navigation:threadSearchContent.newChat"),
      kind: "action",
      icon: SquarePen,
      shortcut: "⌘N",
      disabled: !props.canCreate,
      run: props.onNew,
    },
    {
      id: "choose",
      label: t("navigation:threadSearchContent.openFolder"),
      kind: "action",
      icon: FolderClosed,
      shortcut: "⌘O",
      disabled: props.busy,
      run: props.onChoose,
    },
  ].filter((action) => !actionSearch || action.label.toLocaleLowerCase().includes(actionSearch));
  const groups = [
    {
      label: props.archived
        ? t("navigation:threadSearchContent.archivedChats")
        : t("navigation:threadSearchContent.chat"),
      items: chats,
    },
    { label: t("navigation:threadSearchContent.quickActions"), items: actions },
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
      <DialogTitle className="sr-only">
        {t("navigation:threadSearchContent.searchChats")}
      </DialogTitle>
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
        <CommandInput
          aria-label={t("navigation:threadSearchContent.searchChats")}
          placeholder={t("navigation:threadSearchContent.searchChats")}
        />
        <CommandList>
          <CommandGroup>
            <CommandGroupLabel>
              {props.archived
                ? t("navigation:threadSearchContent.archivedChats")
                : t("navigation:threadSearchContent.chat")}
            </CommandGroupLabel>
            {chats.map((chat, index) => (
              <ThreadContextMenu key={chat.id} id={chat.id} onScheduleOpen={props.onClose}>
                <CommandItem value={chat} onClick={() => choose(() => props.onSelect(chat.id))}>
                  <span className="w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{chat.label}</span>
                  <ThreadItemStatus
                    running={props.runningThreadIds.has(chat.id)}
                    scheduled={props.scheduledThreadIds?.has(chat.id) ?? false}
                    worktree={chat.worktree}
                  />
                  <span className="max-w-28 truncate text-[13px] text-neutral-400">
                    {chat.project}
                  </span>
                  {index < 9 && <Kbd variant="badge">⌃{index + 1}</Kbd>}
                </CommandItem>
              </ThreadContextMenu>
            ))}
            {!chats.length && (
              <p className="px-6 py-3 text-sm text-neutral-400">
                {query.trim()
                  ? t("navigation:threadSearchContent.noMatchingChatsFound")
                  : t("navigation:threadSearchContent.noChatHistory")}
              </p>
            )}
          </CommandGroup>
          {actions.length > 0 && (
            <CommandGroup>
              <CommandGroupLabel>
                {t("navigation:threadSearchContent.quickActions")}
              </CommandGroupLabel>
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

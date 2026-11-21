import { useCallback, useState } from "react";

export interface OpenFileRequest {
  readonly workspaceId?: string;
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly column?: number;
}

export interface OpenFileTab extends OpenFileRequest {
  readonly key: string;
  readonly name: string;
  readonly requestId: string;
}

interface ConnectionFileState {
  readonly tabs: readonly OpenFileTab[];
  readonly activeKey?: string;
}

const MAX_TABS_PER_CONNECTION = 12;
const MAX_CONNECTION_STATES = 20;

function fileBaseName(path: string) {
  const cleaned = path.replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).at(-1) || path;
}

function fileTabKey(workspaceId: string | undefined, path: string) {
  return JSON.stringify([workspaceId ?? "", path]);
}

/** Manages built-in file viewer tabs scoped per conversation connection without losing state. */
export function useFileViewer({
  workspaceId,
  connectionKey,
  onOpen,
}: {
  workspaceId?: string;
  connectionKey: string;
  onOpen: () => void;
}) {
  const [byConnection, setByConnection] = useState<ReadonlyMap<string, ConnectionFileState>>(
    () => new Map(),
  );
  const [refreshRevisions, setRefreshRevisions] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const current = byConnection.get(connectionKey);
  const tabs = current?.tabs ?? [];
  const active = tabs.find((entry) => entry.key === current?.activeKey) ?? tabs.at(-1) ?? undefined;

  const open = useCallback(
    (request: OpenFileRequest) => {
      const effectiveWorkspaceId = request.workspaceId ?? workspaceId;
      const key = fileTabKey(effectiveWorkspaceId, request.path);
      const nextTab: OpenFileTab = {
        ...request,
        workspaceId: effectiveWorkspaceId,
        key,
        name: fileBaseName(request.path),
        requestId: crypto.randomUUID(),
      };
      setByConnection((previous) => {
        const next = new Map(previous);
        const existingState = next.get(connectionKey);
        const existingTabs = existingState?.tabs ?? [];
        const foundIndex = existingTabs.findIndex((entry) => entry.key === key);
        let updatedTabs: OpenFileTab[];
        if (foundIndex >= 0) {
          updatedTabs = existingTabs.map((entry) => (entry.key === key ? nextTab : entry));
        } else {
          updatedTabs = [...existingTabs, nextTab];
          if (updatedTabs.length > MAX_TABS_PER_CONNECTION) {
            updatedTabs = updatedTabs.slice(updatedTabs.length - MAX_TABS_PER_CONNECTION);
          }
        }
        next.delete(connectionKey);
        next.set(connectionKey, { tabs: updatedTabs, activeKey: key });
        while (next.size > MAX_CONNECTION_STATES) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
      onOpen();
    },
    [connectionKey, workspaceId, onOpen],
  );

  const select = useCallback(
    (key: string) => {
      setByConnection((previous) => {
        const state = previous.get(connectionKey);
        if (!state || !state.tabs.some((entry) => entry.key === key) || state.activeKey === key)
          return previous;
        const next = new Map(previous);
        next.set(connectionKey, { ...state, activeKey: key });
        return next;
      });
    },
    [connectionKey],
  );

  const close = useCallback(
    (key: string) => {
      setByConnection((previous) => {
        const state = previous.get(connectionKey);
        if (!state) return previous;
        const index = state.tabs.findIndex((entry) => entry.key === key);
        if (index < 0) return previous;
        const remaining = state.tabs.filter((entry) => entry.key !== key);
        const next = new Map(previous);
        if (!remaining.length) {
          next.delete(connectionKey);
        } else {
          const nextActiveKey =
            state.activeKey === key
              ? remaining[Math.min(index, remaining.length - 1)]!.key
              : state.activeKey;
          next.set(connectionKey, { tabs: remaining, activeKey: nextActiveKey });
        }
        return next;
      });
    },
    [connectionKey],
  );

  const refresh = useCallback((key: string) => {
    setRefreshRevisions((previous) => {
      const next = new Map(previous);
      next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
  }, []);

  return {
    tabs,
    active,
    available: tabs.length > 0,
    open,
    select,
    close,
    refresh,
    refreshRevision: active ? (refreshRevisions.get(active.key) ?? 0) : 0,
  };
}

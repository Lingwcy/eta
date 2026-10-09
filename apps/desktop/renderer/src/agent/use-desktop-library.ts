import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { DesktopLibraryClient } from "@/desktop/library-client";
import type { ModelSelection } from "@/desktop/selectors";

/** Catalog state comes from main; the last active conversation model is separate UI context. */
export function useDesktopLibrary() {
  const [client] = useState(() => new DesktopLibraryClient(window.eta));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [mainModel, setMainModel] = useState<ModelSelection>();
  const selectMainModel = useCallback((model: ModelSelection | undefined) => {
    setMainModel((current) =>
      current?.provider === model?.provider && current?.modelId === model?.modelId
        ? current
        : model,
    );
  }, []);
  useEffect(() => {
    client.connect();
    return () => client.dispose();
  }, [client]);
  return {
    ...state,
    mainModel,
    selectMainModel,
    refresh: client.refresh,
    reload: client.reload,
    act: client.act,
    updateSettings: client.updateSettings,
    clearError: client.clearError,
  };
}

export type DesktopLibraryController = ReturnType<typeof useDesktopLibrary>;

import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { i18n } from "@/i18n";
import { defaultLocale } from "../../../src/shared/i18n/locales.ts";
import { DesktopLibraryClient } from "@/desktop/library-client";
import type { ModelSelection } from "@/desktop/selectors";

/** Catalog state comes from main; the last active conversation model is separate UI context. */
export function useDesktopLibrary() {
  const [client] = useState(() => new DesktopLibraryClient(window.eta));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const locale = state.library?.settings.locale ?? defaultLocale;
  const loaded = state.library !== null;
  useLayoutEffect(() => {
    if (!loaded) return;
    void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
  }, [locale, loaded]);
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

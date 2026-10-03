import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { Alert } from "@/components/ui/alert";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { DesktopLayout } from "./desktop-layout";
import { NavigationRail } from "./sidebar/navigation-rail";
import { SettingsToolbar } from "./settings/settings-toolbar";
import { SettingsSidebar } from "./settings/settings-sidebar";
import { SettingsPage } from "./settings/settings-page";
import { settingsGroups } from "./settings/settings-categories";
import { ModelSettings } from "./settings/model-settings";
import { CredentialSettings } from "./settings/credential-settings";

interface Props {
  library: DesktopLibrary;
  initialCategory?: string;
  onChooseProject: () => void;
  threadId: string | null;
  busy: boolean;
  error: string | null;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
  onClose: () => void;
}
export function DesktopSettings(props: Props) {
  const [category, setCategory] = useState(props.initialCategory ?? "configuration");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);
  return (
    <Tabs
      value={category}
      onValueChange={(value) => setCategory(String(value))}
      orientation="vertical"
      className="contents"
    >
      <DesktopLayout
        collapsed={false}
        toolbar={<SettingsToolbar onClose={props.onClose} />}
        sidebar={
          <>
            <NavigationRail
              archived={false}
              settingsActive
              busy={props.busy}
              onHome={props.onClose}
              onChoose={() => {
                props.onClose();
                props.onChooseProject();
              }}
              onSettings={() => setCategory("configuration")}
            />
            <SettingsSidebar query={query} onQuery={setQuery} onClose={props.onClose} />
          </>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {settingsGroups
            .flatMap((group) => group.items)
            .map((item) => (
              <TabsPanel key={item.id} value={item.id}>
                <SettingsPage title={item.label}>
                  {props.error && (
                    <div className="mb-4">
                      <Alert>{props.error}</Alert>
                    </div>
                  )}
                  {item.id === "configuration" ? (
                    <ModelSettings
                      library={props.library}
                      threadId={props.threadId}
                      busy={props.busy}
                      act={props.act}
                      reconnect={props.reconnect}
                    />
                  ) : (
                    <CredentialSettings
                      library={props.library}
                      busy={props.busy}
                      act={props.act}
                      reconnect={props.reconnect}
                    />
                  )}
                </SettingsPage>
              </TabsPanel>
            ))}
        </div>
      </DesktopLayout>
    </Tabs>
  );
}

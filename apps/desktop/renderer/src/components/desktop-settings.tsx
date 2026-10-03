import { PermissionSettings } from "./settings/permission-settings";
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
import { AuthenticationSettings } from "./settings/authentication/authentication-settings";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  library: DesktopLibrary;
  initialCategory?: string;
  onChooseProject: () => void;
  busy: boolean;
  error: string | null;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
  refresh: () => Promise<void>;
  onClose: () => void;
}
export function DesktopSettings(props: Props) {
  const [category, setCategory] = useState(
    props.initialCategory ??
      (props.library.credentials.find(
        (credential) => credential.providerId === props.library.settings.defaultProvider,
      )?.type === "api_key"
        ? "api-keys"
        : "accounts"),
  );
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
              onSettings={() => setCategory("accounts")}
            />
            <SettingsSidebar query={query} onQuery={setQuery} onClose={props.onClose} />
          </>
        }
      >
        <ScrollArea className="flex-1">
          {settingsGroups
            .flatMap((group) => group.items)
            .map((item) => (
              <TabsPanel key={item.id} value={item.id}>
                <SettingsPage title={item.title}>
                  {props.error && (
                    <div className="mb-4">
                      <Alert>{props.error}</Alert>
                    </div>
                  )}
                  {item.id === "permissions" ? (
                    <PermissionSettings
                      blockImages={Boolean(props.library.settings.blockImages)}
                      busy={props.busy}
                      onAllowImagesChange={(allowed) =>
                        void props.act(async () => {
                          await window.eta.updateSettings({ blockImages: !allowed });
                          await props.refresh();
                        })
                      }
                    />
                  ) : (
                    <AuthenticationSettings
                      library={props.library}
                      method={item.id === "accounts" ? "oauth" : "api_key"}
                      busy={props.busy}
                      act={props.act}
                      reconnect={props.reconnect}
                      refresh={props.refresh}
                    />
                  )}
                </SettingsPage>
              </TabsPanel>
            ))}
        </ScrollArea>
      </DesktopLayout>
    </Tabs>
  );
}

import { AppearanceSettings } from "./settings/appearance-settings";
import { ToolSettings } from "./settings/tool-settings";
import { PermissionSettings } from "./settings/permission-settings";
import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { Alert } from "@/components/ui/alert";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { DesktopLayout } from "./desktop-layout";
import { NavigationRail } from "./sidebar/navigation-rail";
import { SettingsSidebar } from "./settings/settings-sidebar";
import { SettingsPage } from "./settings/settings-page";
import { settingsGroups } from "./settings/settings-categories";
import { AuthenticationSettings } from "./settings/authentication/authentication-settings";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StorageSettings } from "./settings/storage-settings";
import { ConversationSettings } from "./settings/conversation-settings";
import { SkillSettings } from "./settings/skill-settings";

interface Props {
  active?: boolean;
  library: DesktopLibrary;
  initialCategory?: string;
  categoryRevision?: number;
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
    if (props.initialCategory) setCategory(props.initialCategory);
  }, [props.initialCategory, props.categoryRevision]);
  useEffect(() => {
    if (props.active === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose, props.active]);
  return (
    <Tabs
      value={category}
      onValueChange={(value) => setCategory(String(value))}
      orientation="vertical"
      className="contents"
    >
      <DesktopLayout
        collapsed={false}
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
                <SettingsPage title={item.id === "storage" ? undefined : item.title}>
                  {props.error && (
                    <div className="mb-4">
                      <Alert>{props.error}</Alert>
                    </div>
                  )}
                  {item.id === "appearance" ? (
                    <AppearanceSettings
                      variant={props.library.settings.agentThinkingVariant ?? "wave"}
                      active={props.active !== false && category === "appearance"}
                      busy={props.busy}
                      onVariantChange={(agentThinkingVariant) =>
                        void props.act(async () => {
                          await window.eta.updateSettings({ agentThinkingVariant });
                          await props.refresh();
                        })
                      }
                    />
                  ) : item.id === "conversations" ? (
                    <ConversationSettings
                      library={props.library}
                      busy={props.busy}
                      onTitleModelChange={(titleModel) =>
                        void props.act(async () => {
                          await window.eta.updateSettings({ titleModel });
                          await props.refresh();
                        })
                      }
                    />
                  ) : item.id === "storage" ? (
                    <StorageSettings active={props.active !== false && category === "storage"} />
                  ) : item.id === "permissions" ? (
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
                  ) : item.id === "skills" ? (
                    <SkillSettings
                      library={props.library}
                      busy={props.busy}
                      active={props.active !== false && category === "skills"}
                      onChange={(patch) =>
                        props.act(async () => {
                          await window.eta.updateSettings(patch);
                        })
                      }
                    />
                  ) : item.id === "tools" ? (
                    <ToolSettings
                      disabledTools={props.library.settings.disabledTools ?? []}
                      busy={props.busy}
                      onChange={(disabledTools) =>
                        void props.act(async () => {
                          await window.eta.updateSettings({ disabledTools });
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

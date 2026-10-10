import { BotSettings } from "./bot-settings";
import type { ReactNode } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { DesktopSettings } from "../../../../src/shared/settings.ts";
import type { ModelSelection } from "@/desktop/selectors";
import type { SettingsCategory } from "./settings-categories";
import { AppearanceSettings } from "./appearance-settings";
import { SubagentSettings } from "./subagent-settings";
import { ConversationSettings } from "./conversation-settings";
import { PermissionSettings } from "./permission-settings";
import { ToolSettings } from "./tool-settings";
import { SkillSettings } from "./skill-settings";
import { StorageSettings } from "./storage-settings";
import { AboutSettings } from "./about-settings";
import { AuthenticationSettings } from "./authentication/authentication-settings";

export interface SettingsPanelProps {
  library: DesktopLibrary;
  mainModel?: ModelSelection;
  active: boolean;
  busy: boolean;
  updateSettings: (patch: Partial<DesktopSettings>) => Promise<void>;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
  refreshAuthentication: () => Promise<void>;
}

function update(props: SettingsPanelProps, patch: Partial<DesktopSettings>) {
  // Ordinary panels use the shared error banner; subagent forms also display local save errors.
  void props.updateSettings(patch).catch(() => {});
}

const authentication = (props: SettingsPanelProps, method: "oauth" | "api_key") => (
  <AuthenticationSettings
    library={props.library}
    method={method}
    busy={props.busy}
    act={props.act}
    reconnect={props.reconnect}
    refresh={props.refreshAuthentication}
  />
);

export const settingsPanels = {
  bot: (props) => <BotSettings bot={props.library.bot} refresh={props.refreshAuthentication} />,
  accounts: (props) => authentication(props, "oauth"),
  "api-keys": (props) => authentication(props, "api_key"),
  appearance: (props) => (
    <AppearanceSettings
      variant={props.library.settings.agentThinkingVariant ?? "wave"}
      active={props.active}
      busy={props.busy}
      onVariantChange={(agentThinkingVariant) => update(props, { agentThinkingVariant })}
    />
  ),
  subagents: (props) => (
    <SubagentSettings
      library={props.library}
      mainModel={props.mainModel}
      busy={props.busy}
      onChange={(subagents) => props.updateSettings({ subagents })}
    />
  ),
  conversations: (props) => (
    <ConversationSettings
      library={props.library}
      busy={props.busy}
      onTitleModelChange={(titleModel) => update(props, { titleModel })}
    />
  ),
  permissions: (props) => (
    <PermissionSettings
      blockImages={Boolean(props.library.settings.blockImages)}
      busy={props.busy}
      onAllowImagesChange={(allowed) => update(props, { blockImages: !allowed })}
    />
  ),
  tools: (props) => (
    <ToolSettings
      disabledTools={props.library.settings.disabledTools ?? []}
      busy={props.busy}
      onChange={(disabledTools) => update(props, { disabledTools })}
    />
  ),
  skills: (props) => (
    <SkillSettings
      library={props.library}
      busy={props.busy}
      active={props.active}
      onChange={(patch) => props.updateSettings(patch).catch(() => {})}
    />
  ),
  storage: (props) => <StorageSettings active={props.active} />,
  about: (props) => (
    <AboutSettings
      autoCheck={props.library.settings.autoCheckUpdates !== false}
      busy={props.busy}
      onAutoCheckChange={(autoCheckUpdates) => update(props, { autoCheckUpdates })}
    />
  ),
} satisfies Record<SettingsCategory, (props: SettingsPanelProps) => ReactNode>;

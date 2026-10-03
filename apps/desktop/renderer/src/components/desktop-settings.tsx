import type { DesktopLibrary } from "../../../src/bridge.ts";
import { Alert } from "@/components/ui/alert";
import { Sheet } from "@/components/ui/sheet";
import { ModelSettings } from "./settings/model-settings";
import { CredentialSettings } from "./settings/credential-settings";

interface Props {
  library: DesktopLibrary;
  threadId: string | null;
  busy: boolean;
  error: string | null;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
  onClose: () => void;
}
export function DesktopSettings(props: Props) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="模型与认证"
    >
      {props.error && (
        <div className="mb-4">
          <Alert>{props.error}</Alert>
        </div>
      )}
      <ModelSettings
        library={props.library}
        threadId={props.threadId}
        busy={props.busy}
        act={props.act}
        reconnect={props.reconnect}
      />
      <CredentialSettings
        library={props.library}
        busy={props.busy}
        act={props.act}
        reconnect={props.reconnect}
      />
    </Sheet>
  );
}

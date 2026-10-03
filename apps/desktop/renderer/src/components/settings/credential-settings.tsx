import { useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "./settings-section";
import { Input } from "@/components/ui/input";

interface Props {
  library: DesktopLibrary;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
}
export function CredentialSettings(props: Props) {
  const [provider, setProvider] = useState(props.library.models[0]?.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.act(async () => {
            await window.eta.setApiKey(provider.trim(), apiKey);
            setApiKey("");
            props.reconnect();
          });
        }}
      >
        <SettingsSection title="添加认证">
          <SettingsRow title="Provider ID" description="模型服务提供商">
            <Input
              aria-label="Provider ID"
              autoComplete="off"
              value={provider}
              onValueChange={setProvider}
              placeholder="例如 anthropic、openai"
              required
              disabled={props.busy}
            />
          </SettingsRow>
          <SettingsRow title="API key" description="用于连接服务的认证密钥">
            <Input
              aria-label="API key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onValueChange={setApiKey}
              required
              disabled={props.busy}
            />
          </SettingsRow>
          <SettingsRow title="保存认证">
            <Button type="submit" size="sm" disabled={props.busy}>
              保存认证
            </Button>
          </SettingsRow>
        </SettingsSection>
      </form>
      <p className="mt-3 text-xs/5 text-neutral-500">
        认证保存在 Eta 本机数据目录，文件仅当前用户可读写。已有 pi
        认证首次启动时会导入；环境变量也可继续使用。UI 不读取或显示密钥。
      </p>
      {props.library.credentials.length > 0 && (
        <div className="mt-12">
          <SettingsSection title="已保存的认证">
            {props.library.credentials.map((credential) => (
              <SettingsRow
                key={credential.providerId}
                title={credential.providerId}
                description={credential.type}
              >
                <Button
                  variant="ghost-destructive"
                  size="compact"
                  disabled={props.busy}
                  onClick={() =>
                    void props.act(async () => {
                      await window.eta.removeCredential(credential.providerId);
                      props.reconnect();
                    })
                  }
                >
                  移除认证
                </Button>
              </SettingsRow>
            ))}
          </SettingsSection>
        </div>
      )}
    </div>
  );
}

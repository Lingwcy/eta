import { useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
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
    <section className="mt-8">
      <h3 className="mb-3 text-sm font-semibold">Provider 认证</h3>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void props.act(async () => {
            await window.eta.setApiKey(provider.trim(), apiKey);
            setApiKey("");
            props.reconnect();
          });
        }}
      >
        <Field label="Provider ID">
          <Input
            autoComplete="off"
            value={provider}
            onValueChange={setProvider}
            placeholder="例如 anthropic、openai"
            required
            disabled={props.busy}
          />
        </Field>
        <Field label="API key">
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onValueChange={setApiKey}
            required
            disabled={props.busy}
          />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={props.busy}>
            保存认证
          </Button>
        </div>
      </form>
      <p className="mt-3 text-xs/5 text-neutral-500">
        认证保存在 Eta 本机数据目录，文件仅当前用户可读写。已有 pi
        认证首次启动时会导入；环境变量也可继续使用。UI 不读取或显示密钥。
      </p>
      <ul className="mt-4 space-y-3 text-xs">
        {props.library.credentials.map((credential) => (
          <li key={credential.providerId} className="flex items-center justify-between gap-2">
            <span>
              {credential.providerId} · {credential.type}
            </span>
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
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useState } from "react";
import { KeyRound, UserRound } from "lucide-react";
import type { DesktopLibrary } from "../../../../../src/bridge.ts";
import type { LoginMethod } from "../../../../../src/authentication.ts";
import { useAuthentication } from "@/agent/use-authentication";
import { SearchInput } from "@/components/ui/search-input";
import { Alert } from "@/components/ui/alert";
import { LoginDialog } from "./login-dialog";
import { ProviderList } from "./provider-list";
import { ModelPreferences } from "./model-preferences";

export interface AuthenticationSettingsProps {
  library: DesktopLibrary;
  method: LoginMethod;
  threadId: string | null;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
  refresh: () => Promise<void>;
}

export function AuthenticationSettings(props: AuthenticationSettingsProps) {
  const [query, setQuery] = useState("");
  const auth = useAuthentication(props.refresh);
  const providers = props.library.providers.filter((provider) =>
    provider.methods.includes(props.method),
  );
  const connected = props.library.credentials.filter(
    (credential) =>
      credential.type === props.method &&
      providers.some((provider) => provider.id === credential.providerId),
  );
  const search = query.trim().toLocaleLowerCase();
  const visible = providers.filter(
    (provider) =>
      !search ||
      `${provider.name} ${provider.id} ${provider.accountLabel ?? ""}`
        .toLocaleLowerCase()
        .includes(search),
  );
  visible.sort(
    (a, b) =>
      Number(connected.some((entry) => entry.providerId === b.id)) -
      Number(connected.some((entry) => entry.providerId === a.id)),
  );
  const models = props.library.models.filter((model) => {
    const credential = props.library.credentials.find(
      (entry) => entry.providerId === model.provider,
    );
    return props.method === "oauth" ? credential?.type === "oauth" : credential?.type !== "oauth";
  });
  const Icon = props.method === "oauth" ? UserRound : KeyRound;
  return (
    <div>
      <div className="mb-7 flex items-start gap-4 rounded-2xl bg-neutral-50 px-5 py-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-neutral-600 shadow-xs">
          <Icon size={20} />
        </span>
        <div>
          <p className="text-sm font-medium text-neutral-800">
            {props.method === "oauth" ? "连接你的 AI 账户" : "连接自己的模型服务"}
          </p>
          <p className="mt-1 text-xs/5 text-neutral-500">
            {props.method === "oauth"
              ? "使用已有账户或订阅授权，无需手动填写密钥。"
              : "选择服务后，填写 API Key 及所需参数。凭据保存在此电脑。"}
          </p>
          <p className="mt-2 text-xs text-neutral-400">
            {providers.length} 个可连接服务 · {connected.length} 个已连接
          </p>
        </div>
      </div>
      <ModelPreferences
        models={models}
        settings={props.library.settings}
        threadId={props.threadId}
        busy={props.busy}
        act={props.act}
        reconnect={props.reconnect}
      />
      {auth.error && !auth.login && (
        <div className="mb-4">
          <Alert>{auth.error}</Alert>
        </div>
      )}
      <div className="mt-7 mb-4">
        <SearchInput
          aria-label="搜索模型服务"
          placeholder="搜索服务名称"
          value={query}
          onValueChange={setQuery}
        />
      </div>
      <ProviderList
        providers={visible}
        library={props.library}
        method={props.method}
        busy={props.busy || auth.busy || auth.login?.status === "running"}
        onLogin={(provider) => void auth.start(provider, props.method)}
        onRemove={(provider) =>
          void props.act(async () => {
            await window.eta.removeCredential(provider, props.method);
            props.reconnect();
          })
        }
      />

      <LoginDialog
        auth={auth}
        name={
          props.library.providers.find((provider) => provider.id === auth.login?.provider)?.name ??
          "模型服务"
        }
      />
    </div>
  );
}

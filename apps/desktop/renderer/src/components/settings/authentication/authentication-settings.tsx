import { useState } from "react";
import type { DesktopLibrary } from "../../../../../src/bridge.ts";
import type { LoginMethod } from "../../../../../src/authentication.ts";
import { useAuthentication } from "@/agent/use-authentication";
import { SearchInput } from "@/components/ui/search-input";
import { Alert } from "@/components/ui/alert";
import { LoginDialog } from "./login-dialog";
import { ProviderList } from "./provider-list";

export interface AuthenticationSettingsProps {
  library: DesktopLibrary;
  method: LoginMethod;
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
  return (
    <div>
      {auth.error && !auth.login && (
        <div className="mb-4">
          <Alert>{auth.error}</Alert>
        </div>
      )}
      <div className="mb-4">
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

import { useState } from "react";
import type { BotState } from "../../../../src/shared/bot.ts";
import { SettingsRow, SettingsSection } from "./settings-section";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

export function BotSettings({ bot, refresh }: { bot?: BotState; refresh: () => Promise<void> }) {
  const [url, setUrl] = useState(bot?.url ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      await action();
      setToken("");
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Bot 连接失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsSection title="Bot 连接">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => window.eta.connectBot({ url: url.trim(), token: token.trim() }));
          }}
        >
          <SettingsRow
            title="服务器地址"
            description="填写已部署的 Eta Bot 地址。连接后，可选择云端项目并在 Bot 上执行任务。"
          >
            <div className="w-64">
              <Input
                aria-label="Bot 服务器地址"
                placeholder="https://bot.example.com"
                value={url}
                onValueChange={setUrl}
                disabled={busy}
              />
            </div>
          </SettingsRow>
          <SettingsRow title="访问令牌" description="使用 Bot 部署时配置的管理员令牌。">
            <div className="w-64">
              <Input
                type="password"
                autoComplete="off"
                aria-label="Bot 访问令牌"
                placeholder={bot?.url ? "输入令牌以更换连接" : "管理员令牌"}
                value={token}
                onValueChange={setToken}
                disabled={busy}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title="连接状态"
            description={
              bot?.status === "connected"
                ? `已连接 · ${bot.library?.projects.length ?? 0} 个云端项目`
                : (bot?.message ?? "未连接")
            }
          >
            {bot?.url && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => window.eta.reconnectBot())}
                >
                  重新连接
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => window.eta.disconnectBot())}
                >
                  断开连接
                </Button>
              </>
            )}
            <Button size="sm" type="submit" disabled={busy || !url.trim() || !token.trim()}>
              {busy ? "处理中…" : "保存并连接"}
            </Button>
          </SettingsRow>
          {error && <Alert>{error}</Alert>}
        </form>
      </SettingsSection>
      <SettingsSection title="Bot 配置">
        <SettingsRow
          title="模型凭证"
          description="将客户端保存的 API Key 和 OAuth 凭证复制到 Bot。重复导入会更新相同服务商的凭证。"
        >
          <Button
            size="sm"
            disabled={busy || bot?.status !== "connected"}
            onClick={() =>
              void act(async () => {
                const value = await window.eta.importBotCredentials();
                setResult(`已导入 ${value.imported} 个服务商的凭证`);
              })
            }
          >
            {busy ? "处理中…" : "导入客户端凭证"}
          </Button>
        </SettingsRow>
        {bot?.library?.credentials?.map((credential) => (
          <SettingsRow
            key={credential.providerId}
            title={credential.providerId}
            description={credential.type === "oauth" ? "OAuth" : "API Key"}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || bot?.status !== "connected"}
              onClick={() => void act(() => window.eta.removeBotCredential(credential.providerId))}
            >
              移除
            </Button>
          </SettingsRow>
        ))}
        {result && <p className="text-xs text-neutral-500">{result}</p>}
      </SettingsSection>
    </>
  );
}

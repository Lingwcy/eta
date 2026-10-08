import { useEffect, useState } from "react";
import type { AppInfo, UpdateState } from "../../../../src/bridge.ts";
import { useUpdateState } from "@/agent/use-update-state";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "./settings-section";

function describe(state: UpdateState | undefined) {
  switch (state?.status) {
    case undefined:
    case "idle":
      return "尚未检查更新";
    case "unsupported":
      return "开发模式下不可用";
    case "checking":
      return "正在检查更新…";
    case "not-available":
      return "已是最新版本";
    case "available":
      return `发现新版本 v${state.version}，准备下载…`;
    case "downloading":
      return `正在下载 v${state.version} · ${state.percent}%`;
    case "downloaded":
      return `v${state.version} 已下载，重启后完成安装`;
    case "error":
      return "更新失败";
  }
}

export function AboutSettings({
  autoCheck,
  busy,
  onAutoCheckChange,
}: {
  autoCheck: boolean;
  busy: boolean;
  onAutoCheckChange: (enabled: boolean) => void;
}) {
  const [info, setInfo] = useState<AppInfo>();
  const [update, setUpdate] = useUpdateState();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void window.eta.appInfo().then(setInfo, (error: unknown) => setError(String(error)));
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const status = update?.status;
  const unsupported = status === "unsupported";
  const working = status === "checking" || status === "available" || status === "downloading";
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <SettingsSection title="Eta">
        <SettingsRow
          title={info ? `版本 v${info.version}` : "版本"}
          description={
            info &&
            `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}-${info.arch}`
          }
        >
          <Avatar label="Eta" fallback="η" src="./favicon.svg" variant="brand" />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="更新">
        <SettingsRow title="软件更新" description={describe(update)}>
          {status === "downloaded" ? (
            <Button size="sm" onClick={() => void run(() => window.eta.installUpdate())}>
              重启并安装
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={unsupported || working}
              onClick={() => void run(() => window.eta.checkForUpdates().then(setUpdate))}
            >
              检查更新
            </Button>
          )}
        </SettingsRow>
        {update?.status === "error" && (
          <SettingsRow title="无法自动更新" description={update.message}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(() => window.eta.openReleasePage())}
            >
              前往下载页
            </Button>
          </SettingsRow>
        )}
        <SettingsRow
          title="自动检查更新"
          description="启动时和每隔 4 小时检查一次，发现新版本后在后台下载，退出时自动安装。"
        >
          <Button
            size="sm"
            variant={autoCheck ? "secondary" : "outline"}
            disabled={busy || unsupported}
            aria-pressed={autoCheck}
            onClick={() => onAutoCheckChange(!autoCheck)}
          >
            {autoCheck ? "已启用" : "已停用"}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

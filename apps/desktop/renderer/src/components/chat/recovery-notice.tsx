import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
export function RecoveryNotice({
  busy,
  blocked,
  onResume,
  onStop,
}: {
  busy: boolean;
  blocked: boolean;
  onResume: () => void;
  onStop: () => void;
}) {
  return (
    <Alert tone="warning">
      <p>发现未完成任务。恢复可能继续执行工具；尚未自动运行。</p>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || blocked} onClick={onResume}>
          继续原任务
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onStop}>
          停止原任务
        </Button>
      </div>
    </Alert>
  );
}

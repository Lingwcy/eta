import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QueuedInput } from "../../../../src/agent/protocol.ts";

export function QueuedInputs({
  items,
  onWithdraw,
}: {
  items: readonly QueuedInput[];
  onWithdraw?: (id: string) => Promise<void>;
}) {
  const [withdrawing, setWithdrawing] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const withdraw = async (id: string) => {
    if (!onWithdraw || withdrawing.has(id)) return;
    setWithdrawing((ids) => new Set([...ids, id]));
    setError(undefined);
    try {
      await onWithdraw(id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法撤回消息");
    } finally {
      setWithdrawing((ids) => new Set([...ids].filter((value) => value !== id)));
    }
  };
  return (
    <section
      aria-label="待处理输入"
      className="flex flex-col gap-1 border-b border-neutral-100 pb-2"
    >
      <p className="text-xs text-neutral-500">待处理输入 · {items.length}</p>
      <ul className="max-h-40 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 py-1 text-xs">
            <span className="shrink-0 text-neutral-500">
              {item.mode === "steer" ? "引导" : "后续"}
            </span>
            <span className="min-w-0 flex-1 truncate" title={item.text}>
              {item.text || "图片消息"}
              {item.imageCount > 0 && ` · ${item.imageCount} 张图片`}
            </span>
            {onWithdraw && (
              <Button
                variant="ghost-muted"
                size="icon-tiny"
                disabled={withdrawing.has(item.id)}
                onClick={() => void withdraw(item.id)}
                aria-label={`撤回${item.mode === "steer" ? "引导" : "后续"}输入：${item.text || "图片消息"}`}
                title="撤回待处理输入"
              >
                <X size={12} aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}

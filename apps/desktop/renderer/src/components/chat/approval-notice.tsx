import { ChevronRight, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SandboxApproval } from "@eta/core/shared/sandbox";

export function ApprovalNotice({
  requests,
  busy,
  onDecision,
}: {
  requests: readonly SandboxApproval[];
  busy: boolean;
  onDecision: (id: string, approved: boolean) => void;
}) {
  if (!requests.length) return null;
  return (
    <div className="mx-5 -mb-3 rounded-t-[10px] border border-black/12 bg-[#f8f8f8]/95 pb-3 text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] backdrop-blur-xl min-[701px]:mx-7">
      <div className="max-h-[min(280px,35vh)] overflow-y-auto overscroll-contain">
        {requests.map((request) => (
          <section
            key={request.id}
            aria-label={`请求批准：${request.tool}`}
            className="px-1 py-1.5 not-first:border-t not-first:border-black/10"
          >
            <div className="flex items-center gap-1.5 px-2">
              <ShieldQuestion
                size={14}
                strokeWidth={1.7}
                className="shrink-0 text-neutral-500"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-xs">请求批准 · {request.tool}</span>
              {request.networkAccess && (
                <span className="shrink-0 text-[11px] text-neutral-500">联网</span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="compact"
                  disabled={busy}
                  title="仅批准此次操作"
                  onClick={() => onDecision(request.id, true)}
                >
                  批准一次
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={busy}
                  onClick={() => onDecision(request.id, false)}
                >
                  拒绝
                </Button>
              </div>
            </div>
            <details className="group mt-0.5 text-[11px]">
              <summary
                aria-label={`查看权限详情：${request.reason}`}
                title={request.reason}
                className="flex cursor-pointer list-none items-start gap-1.5 rounded-[5px] px-2 py-1 text-neutral-500 outline-none hover:bg-black/5 focus-visible:bg-black/5 [&::-webkit-details-marker]:hidden"
              >
                <ChevronRight
                  size={12}
                  strokeWidth={1.7}
                  className="mt-0.5 shrink-0 group-open:rotate-90"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate leading-4 group-open:whitespace-normal group-open:break-all">
                  {request.reason}
                </span>
              </summary>
              <div className="mx-2 mt-1 space-y-1 border-t border-black/10 pt-2 pb-1 text-neutral-600">
                {request.readableRoots.length > 0 && (
                  <p className="break-all">读取范围：{request.readableRoots.join("、")}</p>
                )}
                {request.writableRoots.length > 0 && (
                  <p className="break-all">写入范围：{request.writableRoots.join("、")}</p>
                )}
                {request.networkAccess && <p>此次操作将允许联网。</p>}
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-[5px] bg-black/4 p-2 leading-4">
                  {JSON.stringify(request.args, null, 2)}
                </pre>
              </div>
            </details>
          </section>
        ))}
      </div>
    </div>
  );
}

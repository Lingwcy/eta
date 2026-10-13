import { Bot, ChevronRight, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SandboxApproval, SandboxReviewSkip } from "@eta/core/shared/sandbox";

type Reuse = "call" | "run";

const skipped: Record<SandboxReviewSkip, string> = {
  "requires-user": "此范围只能由你批准",
  "reviewer-unavailable": "审查模型不可用，已转交给你",
  timeout: "自动审查超时，已转交给你",
  "invalid-output": "审查结果无法解析，已转交给你",
  "circuit-breaker": "连续被自动拒绝，已转交给你",
  "tool-budget": "审查超出工具调用上限，已转交给你",
  interrupted: "审查被中断，已转交给你",
};

/** What automatic review has said about a request that still waits for the user. */
function reviewNote(request: SandboxApproval) {
  const review = request.review;
  if (!review) return undefined;
  if (review.status === "reviewing")
    return review.toolCalls?.length
      ? `自动审查中（已查看 ${review.toolCalls.length} 项）`
      : "自动审查中";
  if (review.status === "escalated")
    return `自动审查建议你确认${review.risk === "high" ? "（高风险）" : ""}：${review.rationale ?? ""}`;
  if (review.status === "skipped" && review.skippedReason) return skipped[review.skippedReason];
  return undefined;
}

function historyLabel(request: SandboxApproval) {
  if (request.decidedBy === "reuse") return "沿用本次运行的批准";
  return request.status === "denied" ? "已自动拒绝" : "已自动批准";
}

function Scope({ request }: { request: SandboxApproval }) {
  return (
    <div className="mx-2 mt-1 space-y-1 border-t border-black/10 pt-2 pb-1 text-neutral-600">
      {request.gitMetadata && (
        <p className="break-all">
          Git 元数据：{request.gitMetadata.branch ? `分支 ${request.gitMetadata.branch}，` : ""}
          仓库 {request.gitMetadata.commonDir}
        </p>
      )}
      {request.readableRoots.length > 0 && (
        <p className="break-all">读取范围：{request.readableRoots.join("、")}</p>
      )}
      {request.writableRoots.length > 0 && (
        <p className="break-all">写入范围：{request.writableRoots.join("、")}</p>
      )}
      {request.networkAccess && <p>此次操作将允许联网。</p>}
      {request.review?.toolCalls?.length ? (
        <p className="break-all">
          审查器查看了：{request.review.toolCalls.map((call) => call.summary).join("、")}
        </p>
      ) : null}
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-[5px] bg-black/4 p-2 leading-4">
        {JSON.stringify(request.args, null, 2)}
      </pre>
    </div>
  );
}

export function ApprovalNotice({
  requests,
  history = [],
  busy,
  onDecision,
}: {
  requests: readonly SandboxApproval[];
  /** Recent automatic decisions, shown collapsed so the user can see what was granted on their behalf. */
  history?: readonly SandboxApproval[];
  busy: boolean;
  onDecision: (id: string, approved: boolean, reuse?: Reuse) => void;
}) {
  if (!requests.length && !history.length) return null;
  return (
    <div className="mx-5 -mb-3 rounded-t-[10px] border border-black/12 bg-[#f8f8f8]/95 pb-3 text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] backdrop-blur-xl min-[701px]:mx-7">
      <div className="max-h-[min(280px,35vh)] overflow-y-auto overscroll-contain">
        {requests.map((request) => {
          const note = reviewNote(request);
          return (
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
                <span className="min-w-0 flex-1 truncate text-xs">
                  请求批准 · {request.gitMetadata ? "Git 写入" : request.tool}
                </span>
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
                  {request.reusable && (
                    <Button
                      variant="outline"
                      size="compact"
                      disabled={busy}
                      title="本次运行中，相同的 Git 范围不再询问。期间任何申请该范围的命令都能写这些 Git 目录（不含 config 与 hooks）。"
                      onClick={() => onDecision(request.id, true, "run")}
                    >
                      本次运行内允许
                    </Button>
                  )}
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
              {note && <p className="mt-0.5 px-2 text-[11px] break-all text-neutral-500">{note}</p>}
              {request.reusable && (
                <p className="mt-0.5 px-2 text-[11px] text-neutral-500">
                  本次运行内允许后，任何申请相同范围的命令都能写这些 Git 目录，包括共享对象库；不含
                  config 与 hooks。
                </p>
              )}
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
                <Scope request={request} />
              </details>
            </section>
          );
        })}
        {history.length > 0 && (
          <details
            className="group/history px-1 pt-1.5 text-[11px] not-first:border-t not-first:border-black/10"
            aria-label="自动审查记录"
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-[5px] px-2 py-1 text-neutral-500 outline-none hover:bg-black/5 focus-visible:bg-black/5 [&::-webkit-details-marker]:hidden">
              <Bot size={13} strokeWidth={1.7} className="shrink-0" aria-hidden="true" />
              <span className="flex-1">自动审查记录（{history.length}）</span>
              <ChevronRight
                size={12}
                strokeWidth={1.7}
                className="shrink-0 group-open/history:rotate-90"
                aria-hidden="true"
              />
            </summary>
            {history.toReversed().map((request) => (
              <details key={request.id} className="group mt-0.5">
                <summary className="flex cursor-pointer list-none items-start gap-1.5 rounded-[5px] px-2 py-1 text-neutral-600 outline-none hover:bg-black/5 focus-visible:bg-black/5 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    size={12}
                    strokeWidth={1.7}
                    className="mt-0.5 shrink-0 group-open:rotate-90"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate group-open:whitespace-normal group-open:break-all">
                    {historyLabel(request)} · {request.gitMetadata ? "Git 写入" : request.tool}
                    {request.review?.rationale ? ` · ${request.review.rationale}` : ""}
                  </span>
                </summary>
                {request.review?.reviewer && (
                  <p className="mx-2 mt-1 text-neutral-500">
                    审查模型：{request.review.reviewer.provider}/{request.review.reviewer.modelId}
                  </p>
                )}
                <Scope request={request} />
              </details>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}

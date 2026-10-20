import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Bot, ChevronRight, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SandboxApproval, SandboxReviewSkip } from "@eta/core/shared/sandbox";

type Reuse = "call" | "run";

const skipped = () =>
  ({
    "requires-user": t("chat:approvalNotice.onlyYouCanApproveThisScope"),
    "reviewer-unavailable": t("chat:approvalNotice.theReviewModelIsUnavailableYourApproval"),
    timeout: t("chat:approvalNotice.automaticReviewTimedOutYourApprovalIs"),
    "invalid-output": t("chat:approvalNotice.theReviewResultCouldNotBeParsed"),
    "circuit-breaker": t("chat:approvalNotice.repeatedAutomaticDenialsYourApprovalIsNeeded"),
    "tool-budget": t("chat:approvalNotice.theReviewExceededItsToolCallLimit"),
    interrupted: t("chat:approvalNotice.theReviewWasInterruptedYourApprovalIs"),
  }) satisfies Record<SandboxReviewSkip, string>;

/** What automatic review has said about a request that still waits for the user. */
function reviewNote(request: SandboxApproval) {
  const review = request.review;
  if (!review) return undefined;
  if (review.status === "reviewing")
    return review.toolCalls?.length
      ? t("chat:approvalNotice.automaticReviewCheckedItems", { count: review.toolCalls.length })
      : t("chat:approvalNotice.automaticReviewInProgress");
  if (review.status === "escalated")
    return t("chat:approvalNotice.theReviewerRecommendsYourConfirmation", {
      value1: review.risk === "high" ? t("chat:approvalNotice.highRisk") : "",
      value2: review.rationale ?? "",
    });
  if (review.status === "skipped" && review.skippedReason) return skipped()[review.skippedReason];
  return undefined;
}

function historyLabel(request: SandboxApproval) {
  if (request.decidedBy === "reuse") return t("chat:approvalNotice.reusingApprovalForThisRun");
  return request.status === "denied"
    ? t("chat:approvalNotice.automaticallyDenied")
    : t("chat:approvalNotice.automaticallyApproved");
}

function Scope({ request }: { request: SandboxApproval }) {
  useTranslation();
  return (
    <div className="mx-2 mt-1 space-y-1 border-t border-black/10 pt-2 pb-1 text-neutral-600">
      {request.gitMetadata && (
        <p className="break-all">
          {t("chat:approvalNotice.gitMetadata")}
          {request.gitMetadata.branch
            ? t("chat:approvalNotice.branch", { branch: request.gitMetadata.branch })
            : ""}
          {t("chat:approvalNotice.repository")}
          {request.gitMetadata.commonDir}
        </p>
      )}
      {request.readableRoots.length > 0 && (
        <p className="break-all">
          {t("chat:approvalNotice.readScope")}
          {request.readableRoots.join("、")}
        </p>
      )}
      {request.writableRoots.length > 0 && (
        <p className="break-all">
          {t("chat:approvalNotice.writeScope")}
          {request.writableRoots.join("、")}
        </p>
      )}
      {request.networkAccess && (
        <p>{t("chat:approvalNotice.thisOperationWillHaveNetworkAccess")}</p>
      )}
      {request.review?.toolCalls?.length ? (
        <p className="break-all">
          {t("chat:approvalNotice.theReviewerChecked")}
          {request.review.toolCalls.map((call) => call.summary).join("、")}
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
  useTranslation();
  if (!requests.length && !history.length) return null;
  return (
    <div className="mx-5 -mb-3 rounded-t-[10px] border border-black/12 bg-[#f8f8f8]/95 pb-3 text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] backdrop-blur-xl min-[701px]:mx-7">
      <div className="max-h-[min(280px,35vh)] overflow-y-auto overscroll-contain">
        {requests.map((request) => {
          const note = reviewNote(request);
          return (
            <section
              key={request.id}
              aria-label={t("chat:approvalNotice.approvalRequested", { tool: request.tool })}
              className="px-1 py-1.5 not-first:border-t not-first:border-black/10"
            >
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2">
                <ShieldQuestion
                  size={14}
                  strokeWidth={1.7}
                  className="shrink-0 text-neutral-500"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {t("chat:approvalNotice.approvalRequested2")}
                  {request.gitMetadata ? t("chat:approvalNotice.gitWrites") : request.tool}
                </span>
                {request.networkAccess && (
                  <span className="shrink-0 text-[11px] text-neutral-600">
                    {t("chat:approvalNotice.network")}
                  </span>
                )}
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                  <Button
                    variant="outline"
                    size="compact"
                    disabled={busy}
                    title={t("chat:approvalNotice.approveThisOperationOnly")}
                    onClick={() => onDecision(request.id, true)}
                  >
                    {t("chat:approvalNotice.approveOnce")}
                  </Button>
                  {request.reusable && (
                    <Button
                      variant="outline"
                      size="compact"
                      disabled={busy}
                      title={t("chat:approvalNotice.doNotAskAgainForTheSame")}
                      onClick={() => onDecision(request.id, true, "run")}
                    >
                      {t("chat:approvalNotice.allowForThisRun")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={busy}
                    onClick={() => onDecision(request.id, false)}
                  >
                    {t("chat:approvalNotice.deny")}
                  </Button>
                </div>
              </div>
              {note && <p className="mt-0.5 px-2 text-xs break-all text-neutral-600">{note}</p>}
              {request.reusable && (
                <p className="mt-0.5 px-2 text-xs text-neutral-600">
                  {t("chat:approvalNotice.afterAllowingThisScopeForTheRun")}
                </p>
              )}
              <details className="group mt-0.5 text-xs">
                <summary
                  aria-label={t("chat:approvalNotice.viewPermissionDetails", {
                    reason: request.reason,
                  })}
                  title={request.reason}
                  className="flex cursor-pointer list-none items-start gap-1.5 rounded-[5px] px-2 py-1 text-neutral-600 outline-none hover:bg-black/5 focus-visible:bg-black/5 [&::-webkit-details-marker]:hidden"
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
            aria-label={t("chat:approvalNotice.automaticReviewHistory")}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-[5px] px-2 py-1 text-neutral-500 outline-none hover:bg-black/5 focus-visible:bg-black/5 [&::-webkit-details-marker]:hidden">
              <Bot size={13} strokeWidth={1.7} className="shrink-0" aria-hidden="true" />
              <span className="flex-1">
                {t("chat:approvalNotice.historyCount", { count: history.length })}
              </span>
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
                    {historyLabel(request)} ·{" "}
                    {request.gitMetadata ? t("chat:approvalNotice.gitWrites") : request.tool}
                    {request.review?.rationale ? ` · ${request.review.rationale}` : ""}
                  </span>
                </summary>
                {request.review?.reviewer && (
                  <p className="mx-2 mt-1 text-neutral-500">
                    {t("chat:approvalNotice.reviewModel")}
                    {request.review.reviewer.provider}/{request.review.reviewer.modelId}
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

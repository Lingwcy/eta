import { readFile } from "node:fs/promises";
import { Schema } from "effect";

const LogSummary = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("review"),
    requestId: Schema.String,
    outcome: Schema.String,
    durationMs: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("user-decision"),
    requestId: Schema.String,
    approved: Schema.Boolean,
    review: Schema.String,
  }),
]);
const decodeSummary = Schema.decodeUnknownSync(LogSummary);

export interface ReviewStats {
  readonly reviews: number;
  readonly approved: number;
  readonly denied: number;
  readonly escalated: number;
  readonly skipped: number;
  /** Escalations the user then approved; a low share means the reviewer is shirking judgement. */
  readonly escalatedApproved: number;
  readonly averageMs: number;
}

/** Summary of the most recent review log entries; a missing log is an empty summary. */
export async function readReviewStats(path: string, window = 200): Promise<ReviewStats> {
  const text = await readFile(path, "utf8").catch(() => "");
  const entries = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [decodeSummary(JSON.parse(line))];
      } catch {
        return [];
      }
    })
    .slice(-window * 2);
  const reviews = entries.filter((entry) => entry.kind === "review").slice(-window);
  const count = (outcome: string) => reviews.filter((entry) => entry.outcome === outcome).length;
  const decisions = entries.filter((entry) => entry.kind === "user-decision");
  const escalatedIds = new Set(
    reviews
      .filter((entry) => entry.outcome === "escalated" || entry.outcome === "skipped")
      .map((entry) => entry.requestId),
  );
  return {
    reviews: reviews.length,
    approved: count("approved"),
    denied: count("denied"),
    escalated: count("escalated"),
    skipped: count("skipped"),
    escalatedApproved: new Set(
      decisions
        .filter((entry) => entry.approved && escalatedIds.has(entry.requestId))
        .map((entry) => entry.requestId),
    ).size,
    averageMs: reviews.length
      ? Math.round(reviews.reduce((sum, entry) => sum + entry.durationMs, 0) / reviews.length)
      : 0,
  };
}

import { readFile } from "node:fs/promises";
import type { ReviewRecord } from "./review.ts";

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
        return [JSON.parse(line) as ReviewRecord];
      } catch {
        return [];
      }
    })
    .slice(-window * 2);
  const reviews = entries.filter((entry) => entry.kind === "review").slice(-window);
  const count = (outcome: string) => reviews.filter((entry) => entry.outcome === outcome).length;
  const decisions = entries.filter((entry) => entry.kind === "user-decision");
  return {
    reviews: reviews.length,
    approved: count("approved"),
    denied: count("denied"),
    escalated: count("escalated"),
    skipped: count("skipped"),
    escalatedApproved: decisions.filter((entry) => entry.review === "escalated" && entry.approved)
      .length,
    averageMs: reviews.length
      ? Math.round(reviews.reduce((sum, entry) => sum + entry.durationMs, 0) / reviews.length)
      : 0,
  };
}

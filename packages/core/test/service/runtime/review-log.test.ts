import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { readReviewStats } from "../../../src/service/runtime/review-log.ts";

test("recent review statistics count only user decisions belonging to the same review window", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-review-log-"));
  try {
    const path = join(root, "reviews.jsonl");
    await writeFile(
      path,
      [
        { kind: "review", requestId: "old", outcome: "escalated", durationMs: 500 },
        { kind: "review", requestId: "a", outcome: "approved", durationMs: 100 },
        { kind: "review", requestId: "b", outcome: "skipped", durationMs: 300 },
        { kind: "user-decision", requestId: "old", review: "escalated", approved: true },
        { kind: "user-decision", requestId: "b", review: "skipped", approved: true },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    expect(await readReviewStats(path, 2)).toMatchObject({
      reviews: 2,
      approved: 1,
      skipped: 1,
      escalatedApproved: 1,
      averageMs: 200,
    });
    await writeFile(
      path,
      '\nnull\n42\n{"kind":"review"}\n{"kind":"review","requestId":"valid","outcome":"denied","durationMs":400}\n{',
    );
    expect(await readReviewStats(path)).toMatchObject({ reviews: 1, denied: 1, averageMs: 400 });
    expect(await readReviewStats(join(root, "missing"))).toMatchObject({
      reviews: 0,
      averageMs: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

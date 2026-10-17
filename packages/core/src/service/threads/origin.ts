import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor, Storage, SubmissionRecord, TaskId } from "@eta/agent";
import { Schema } from "effect";

const ReporterId = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

/** Attribute autonomous reports using the spawning task's durable input/answer interval, including old sessions. */
export async function readOperationOrigin(storage: Storage, receipt: SubmissionRecord) {
  let history: readonly SubmissionRecord[] | undefined;
  const pending = [receipt];
  const seen = new Set<number>();
  let origin: string | undefined;
  while (pending.length) {
    const input = pending.pop()!;
    if (seen.has(input.id)) continue;
    // An unexpectedly large or ambiguous ancestry keeps manual recovery rather than guessing.
    if (input.type !== "input" || input.entry === undefined || seen.size >= 256) return undefined;
    seen.add(input.id);
    if (!input.requestId?.startsWith("subagent-report:")) {
      const root = String(input.id);
      if (origin !== undefined && origin !== root) return undefined;
      origin = root;
      continue;
    }
    let id: number;
    try {
      id = Schema.decodeUnknownSync(ReporterId)(input.requestId.slice("subagent-report:".length));
    } catch {
      return undefined;
    }
    const reporter = await storage.task(id as TaskId, BACKGROUND_CONTEXT);
    if (
      !reporter ||
      !["eta.subagent-reporter", "eta.subagent-timeout"].includes(reporter.kind) ||
      reporter.conversationId !== input.conversationId ||
      reporter.id >= input.entry
    )
      return undefined;
    if (!history) {
      const inputs: SubmissionRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanSubmissions(
          { conversationId: receipt.conversationId },
          64,
          cursor,
          BACKGROUND_CONTEXT,
        );
        inputs.push(...page.items);
        cursor = page.next;
      } while (cursor);
      history = inputs;
    }
    // Both bounds are required: a previous schedule in this chat does not establish ownership.
    const owners = history.filter(
      (candidate) =>
        candidate.type === "input" &&
        candidate.status === "done" &&
        candidate.entry < reporter.id &&
        candidate.answer > reporter.id,
    );
    if (!owners.length) return undefined;
    pending.push(...owners);
  }
  return origin;
}

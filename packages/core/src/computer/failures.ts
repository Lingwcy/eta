import type { NestedToolExecutionResult } from "@eta/agent";
import { Predicate } from "effect";

const short = (value: unknown, limit: number) =>
  typeof value === "string"
    ? value.length > limit
      ? value.slice(0, limit) + " [truncated]"
      : value
    : undefined;

/** Durable failures remain visible even if a script prints only success-shaped fields. */
export function computerFailureReport() {
  const entries: string[] = [];
  let remaining = 8000;
  let count = 0;
  let stopped = false;
  return {
    add(
      id: number,
      result?: Pick<NestedToolExecutionResult, "isError" | "structuredOutput" | "diagnostics">,
    ) {
      if (!result?.isError) return;
      count++;
      const value = Predicate.isObject(result.structuredOutput)
        ? result.structuredOutput
        : undefined;
      const error = Predicate.isObject(value?.error) ? value.error : undefined;
      if (error?.code === "user_interrupted") stopped = true;
      if (remaining < 2000) return;
      const verification = Predicate.isObject(value?.verification) ? value.verification : undefined;
      const diagnostic =
        result.diagnostics.find((item) => item.severity === "error") ?? result.diagnostics[0];
      // Never copy arbitrary structured fields, screenshots, call arguments or UI details.
      const text = JSON.stringify({
        callId: id,
        error: {
          code: short(error?.code ?? diagnostic?.code, 80) ?? "computer_failed",
          message:
            short(error?.message ?? diagnostic?.message, 400) ??
            "Computer call failed without a diagnostic",
        },
        applied: short(value?.applied, 16) ?? "unknown",
        verification: verification
          ? {
              status: short(verification.status, 32),
              noOp: typeof verification.noOp === "boolean" ? verification.noOp : undefined,
              reason: short(verification.reason, 128),
            }
          : undefined,
        recovery: short(value?.recovery, 400),
      });
      if (text.length > remaining) return;
      entries.push(text);
      remaining -= text.length;
    },
    text() {
      if (!count) return undefined;
      const omitted = count - entries.length;
      return [
        "Nested computer call failures (script completion is not action success; later calls may have recovered):",
        ...entries,
        ...(omitted
          ? [String(omitted) + " more failures omitted; inspect the nested call records."]
          : []),
        stopped
          ? "The user explicitly stopped desktop control. Stop computer-use for this task and wait for a new user instruction; do not retry, re-observe or reacquire control."
          : "Check applied/verification, recovery and later results before continuing. Never blindly replay earlier successful or uncertain actions.",
      ].join("\n");
    },
  };
}

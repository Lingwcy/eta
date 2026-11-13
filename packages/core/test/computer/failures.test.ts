import { expect, test } from "vite-plus/test";
import { computerFailureReport } from "../../src/computer/failures.ts";

test("successes produce no warning, while only whitelisted failure evidence reaches the model", () => {
  const report = computerFailureReport();
  report.add(1, { isError: false, structuredOutput: { ok: true }, diagnostics: [] });
  expect(report.text()).toBeUndefined();
  report.add(2, {
    isError: true,
    structuredOutput: {
      ok: false,
      error: { code: "input_failed", message: "Readback failed" },
      applied: "yes",
      verification: { status: "unknown", reason: "state_unavailable" },
      recovery: "Observe before retrying",
      image: { data: "do-not-echo-image" },
      extra: "do-not-echo-arbitrary-fields",
    },
    diagnostics: [],
  });
  const text = report.text()!;
  expect(text).toContain('"callId":2');
  expect(text).toContain('"applied":"yes"');
  expect(text).toContain('"status":"unknown"');
  expect(text).toContain("Observe before retrying");
  expect(text).not.toContain("do-not-echo");
});

test("harness-side rejections retain their diagnostic without inventing non-delivery", () => {
  const report = computerFailureReport();
  report.add(3, {
    isError: true,
    diagnostics: [
      { severity: "error", code: "invalid_arguments", message: "elementIndex must be an integer" },
    ],
  });
  expect(report.text()).toContain("elementIndex must be an integer");
  expect(report.text()).toContain('"applied":"unknown"');
});

test("many escaped diagnostics stay bounded and explicitly report omitted calls", () => {
  const report = computerFailureReport();
  const huge = String.fromCharCode(0).repeat(100000);
  for (let id = 0; id < 1000; id++) {
    report.add(id, {
      isError: true,
      structuredOutput: {
        error: { code: "invalid_input", message: huge },
        applied: "no",
        verification: { status: "unverified", reason: huge },
        recovery: huge,
      },
      diagnostics: [],
    });
  }
  const text = report.text()!;
  expect(text.length).toBeLessThan(8500);
  expect(text).toContain("more failures omitted");
  const first = JSON.parse(text.split("\n")[1]!);
  expect(first).toMatchObject({
    callId: 0,
    error: { code: "invalid_input" },
    applied: "no",
    verification: { status: "unverified" },
  });
  expect(first.error.message).toContain("[truncated]");
});

test("an explicit user stop remains visible even when earlier failures exhaust the preview budget", () => {
  const report = computerFailureReport();
  for (let id = 0; id < 100; id++) {
    report.add(id, {
      isError: true,
      structuredOutput: {
        error: { code: "invalid_input", message: "long".repeat(1000) },
        recovery: "explanation".repeat(1000),
      },
      diagnostics: [],
    });
  }
  report.add(101, {
    isError: true,
    structuredOutput: { error: { code: "user_interrupted", message: "Stopped" }, applied: "no" },
    diagnostics: [],
  });
  expect(report.text()).toContain("wait for a new user instruction");
  expect(report.text()).toContain("do not retry");
  expect(report.text()!.length).toBeLessThan(8500);
});

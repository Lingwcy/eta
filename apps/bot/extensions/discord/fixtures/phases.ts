export interface PhaseMark {
  phase: string;
  ms: number;
}

/**
 * A restore that overruns its test budget otherwise leaves only "Test timed out" behind.
 * This reports where the time went: on failure, and shortly before the budget would expire.
 */
export class PhaseLog {
  private readonly marks: PhaseMark[] = [];
  private started = performance.now();
  private reported = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    budgetMs: number,
    private readonly report: (value: unknown) => void = (value) =>
      console.error("Discord restore phases", JSON.stringify(value)),
  ) {
    this.timer = setTimeout(() => this.flush("deadline", budgetMs), Math.max(0, budgetMs - 1000));
    this.timer.unref?.();
  }

  phase(name: string) {
    const now = performance.now();
    this.marks.push({ phase: name, ms: Math.round(now - this.started) });
    this.started = now;
  }

  private flush(reason: "deadline" | "failed", budgetMs: number) {
    if (this.reported) return;
    this.reported = true;
    this.report({
      reason,
      budgetMs,
      elapsedMs: Math.round(performance.now() - this.started),
      phases: [...this.marks],
    });
  }

  /** Reports the phases of an attempt that failed before its budget expired. */
  failed(budgetMs: number) {
    this.flush("failed", budgetMs);
  }

  stop() {
    clearTimeout(this.timer);
  }
}

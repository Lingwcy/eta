import { defineTask } from "@eta/agent";
import { Schema } from "effect";
import type { CoreClient } from "@eta/core";
import type { OperationResult } from "@eta/core";

export const ISSUE_TASK_KIND = "eta.bot.discord-reply";
const Input = Schema.Struct({
  inboxId: Schema.String,
  etaThreadId: Schema.String,
  operationId: Schema.String,
});
type Input = typeof Input.Type;
type State = { phase: "result" } | { phase: "delivery" };
export interface IssueCapabilities {
  core(): CoreClient;
  stage(input: Input, result: OperationResult): void;
  deliver(inboxId: string, signal: AbortSignal): Promise<boolean>;
  finish(inboxId: string): void;
  cancel(inboxId: string): void;
}

/** Model execution already has a durable receipt; this task persists the result-to-delivery handoff. */
export function createIssueTask(capabilities: IssueCapabilities) {
  return defineTask<Input, State, string>({
    name: ISSUE_TASK_KIND,
    version: 1,
    initial: (input) => {
      Schema.decodeUnknownSync(Input)(input);
      return { phase: "result" };
    },
    phases: {
      result: async (task, runtime, context) => {
        while (true) {
          runtime.signal.throwIfAborted();
          const result = await capabilities
            .core()
            .operation(task.input.etaThreadId, task.input.operationId);
          runtime.signal.throwIfAborted();
          if (["completed", "failed", "aborted"].includes(result.status)) {
            capabilities.stage(task.input, result);
            await runtime.commit(
              () => ({ status: "running", checkpoint: { phase: "delivery" } }),
              context,
            );
            return;
          }
          await runtime.sleep(runtime.now() + 100, context);
        }
      },
      delivery: async (task, runtime, context) => {
        while (!(await capabilities.deliver(task.input.inboxId, runtime.signal)))
          await runtime.sleep(runtime.now() + 1000, context);
        runtime.signal.throwIfAborted();
        capabilities.finish(task.input.inboxId);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: task.input.inboxId },
          }),
          context,
        );
      },
    },
    abort: (task, runtime, context) => {
      capabilities.cancel(task.input.inboxId);
      return runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
}

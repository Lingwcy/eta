import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SandboxedExecutionEnv } from "../../src/platform/sandbox/environment.ts";
import { createReviewToolRunner } from "../../src/service/runtime/review-tools.ts";

const root = process.argv[2];
const env = await SandboxedExecutionEnv.open({
  mode: "read-only",
  workspaceRoot: root,
  commandAccess: true,
});
const runner = createReviewToolRunner(async () => env, root);
try {
  const outcomes = [];
  for (const [path, offset] of [
    ["small.txt", 1],
    ["large.txt", 1],
    ["large.txt", 2],
    ["small.txt", 1],
  ]) {
    outcomes.push(
      await runner.execute(
        { type: "toolCall", id: path, name: "read", arguments: { path, offset, limit: 1 } },
        context,
      ),
    );
  }
  console.log(JSON.stringify(outcomes));
} finally {
  await runner.cleanup(context);
}

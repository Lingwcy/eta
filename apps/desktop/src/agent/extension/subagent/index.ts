import { defineExtension } from "@eta/agent";
import type { SubagentOptions } from "./options.ts";
import { createSubagentRuntime } from "./runtime.ts";
import { createSubagentTasks } from "./tasks.ts";
import { createSubagentTools } from "./tools.ts";
import { createSubagentPrompt } from "./prompt.ts";
import { createSubagentActions } from "./actions.ts";
import { createSubagentHooks } from "./hooks.ts";

export { SubagentsDoc, SubagentEventEntry } from "./state.ts";

export function createSubagentsExtension(options: SubagentOptions) {
  const runtime = createSubagentRuntime(options);
  const tasks = createSubagentTasks(runtime);
  const actions = createSubagentActions(runtime, tasks, () => tool);
  const { tool, updateTool } = createSubagentTools(runtime, actions);
  const extension = defineExtension({
    name: "desktop-subagents",
    tasks: [tasks.Anchor, tasks.Reporter, tasks.Steering, tasks.Timeout],
    tools: [tool, updateTool],
    sections: [createSubagentPrompt(runtime)],
    hooks: createSubagentHooks(runtime),
  });
  return { extension, tool, updateTool, ...actions };
}

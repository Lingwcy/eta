import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	defineTask,
	defineTool,
	MemoryStorage,
	type NestedToolExecutionResult,
	ToolTask,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { deferred, eventually } from "./task-support.ts";

it("nested calls wait for authorization before executing and retain the parent identity", async () => {
	const setup = chatSetup();
	const reached = deferred();
	const released = deferred();
	let approved = false;
	let executions = 0;
	let parent: string | undefined;
	let result: NestedToolExecutionResult | undefined;
	const approval = defineTask<null, { phase: "decide" }, boolean>({
		name: "eta.test-approval",
		version: 1,
		initial: () => ({ phase: "decide" }),
		phases: {
			decide: async (_task, runtime, context) => {
				reached.resolve();
				await released.promise;
				approved = true;
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: true } }),
					context,
				);
			},
		},
	});
	setup.registry.install({ name: "approval", tasks: [approval] });
	addTool(setup.registry, defineTool({
		name: "inner",
		description: "inner",
		parameters: Type.Object({}),
		callers: ["tools"],
		execute: async () => {
			executions++;
			return { output: [{ type: "text", text: "authorized" }] };
		},
	}));
	addTool(setup.registry, defineTool({
		name: "outer",
		description: "outer",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			result = await api.executeTool("inner", {}, context);
			return { output: [{ type: "text", text: "finished" }] };
		},
	}));
	addHooks(setup.registry, ToolTask, {
		authorizeTool: async (call, api, context) => {
			if (call.name !== "inner") return;
			parent = call.parent?.callId;
			if (!approved) return {
				waitFor: await root.commit(
					(tx) => tx.createTask(approval, null, { ownership: { kind: "task", taskId: api.taskId } }),
					context,
				),
			};
		},
	});
	setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("outer", {}, { id: "outer-call" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	try {
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await eventually(async () => {
			const tasks = await harness.commit((tx) => tx.scanTasks({ kind: approval.definition.name }, 10), context);
			return tasks.items.length === 1;
		});
		await reached.promise;
		expect(executions).toBe(0);
		expect(parent).toBe("outer-call");
		released.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		expect(executions).toBe(1);
		expect(result).toMatchObject({ structuredOutput: "authorized" });
		expect(result?.isError).not.toBe(true);
		expect(setup.reports).toEqual([]);
	} finally {
		released.resolve();
		await harness.close(context);
	}
});

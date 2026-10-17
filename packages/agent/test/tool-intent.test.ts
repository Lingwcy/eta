import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Models, type Message, Type } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { modelParameters, TOOL_INTENT, toolIntents } from "../src/harness/tool-intent.ts";
import { createCodingTools } from "../src/tools/index.ts";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const done = fauxAssistantMessage("done");

test("new declarations request summaries while old and new calls execute the same business arguments", async () => {
	const directory = await mkdtemp(join(tmpdir(), "eta-intent-"));
	const setup = chatSetup();
	setup.registry.install(createCodingTools());
	setup.faux.setResponses([
		(request) => {
			const tools = getCurrentTools(request.messages);
			for (const tool of tools)
				expect(tool.parameters).toHaveProperty("required", expect.arrayContaining(["description"]));
			return fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "old.txt", content: "old" }, { id: "old" }),
					fauxToolCall("write", { description: "保存测试文件", path: "new.txt", content: "new" }, { id: "new" }),
				],
				{ stopReason: "toolUse" },
			);
		},
		done,
	]);
	const { harness, root } = await openChat(new MemoryStorage(), setup, {
		env: new NodeExecutionEnv({ cwd: directory }),
	});
	try {
		const result = await (await root.submit({ type: "input", content: "write" }, context)).wait(context);
		expect(result.status).toBe("done");
		expect(await readFile(join(directory, "old.txt"), "utf8")).toBe("old");
		expect(await readFile(join(directory, "new.txt"), "utf8")).toBe("new");
		const messages = (await allEntries(root)).flatMap((entry) => [...(entry.model ?? [])]);
		expect(toolIntents(messages)).toEqual({ new: "保存测试文件" });
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("partial summaries reach live state while the command is held and no tool has executed", async () => {
	const base = chatSetup();
	base.registry.install(createCodingTools());
	const release = deferred();
	const raw = '{"description":"检查并发\\n配置 😀","command":"';
	const final = fauxAssistantMessage(
		fauxToolCall("bash", { description: "检查并发\n配置 😀", command: "printf ready" }, { id: "call" }),
		{ stopReason: "toolUse" },
	);
	let count = 0;
	const streamSimple: Models["streamSimple"] = () => {
		const stream = createAssistantMessageEventStream();
		if (count++ > 0) {
			stream.end(done);
			return stream;
		}
		void (async () => {
			let json = "";
			for (const char of raw) {
				json += char;
				const partial = fauxAssistantMessage(fauxToolCall("bash", parseStreamingJson(json), { id: "call" }), {
					stopReason: "pending",
					timestamp: final.timestamp,
				});
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: char, partial });
			}
			await release.promise;
			stream.end(final);
		})();
		return stream;
	};
	const models = new Proxy(base.models, {
		get(target, key) {
			if (key === "streamSimple") return streamSimple;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "eta-intent-stream-"));
	const { harness, root } = await openChat(
		new MemoryStorage(),
		{ ...base, models },
		{ env: new NodeExecutionEnv({ cwd: directory }) },
	);
	try {
		const submission = await root.submit({ type: "input", content: "run" }, context);
		await waitFor(async () => Boolean((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message));
		const live = (await harness.snapshot(LiveDoc, root.id, context))!;
		const messages = (await allEntries(root)).flatMap((entry) => [...(entry.model ?? [])]);
		expect(toolIntents(messages, live.generation!.message)).toEqual({ call: "检查并发 配置 😀" });
		expect(live.tools ?? []).toEqual([]);
		release.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		const results = (await allEntries(root))
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "toolResult");
		expect(results).toMatchObject([{ isError: false }]);
	} finally {
		release.resolve();
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("reused provider call IDs execute independent turns without retaining old summaries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "eta-intent-reuse-"));
	const setup = chatSetup();
	setup.registry.install(createCodingTools());
	setup.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { description: "Earlier write", path: "first.txt", content: "first" }, { id: "reused" }),
			{ stopReason: "toolUse" },
		),
		done,
		fauxAssistantMessage(
			fauxToolCall("write", { path: "second.txt", content: "second" }, { id: "reused" }),
			{ stopReason: "toolUse" },
		),
		done,
	]);
	const { harness, root } = await openChat(new MemoryStorage(), setup, {
		env: new NodeExecutionEnv({ cwd: directory }),
	});
	try {
		for (const prompt of ["first", "second"])
			expect((await (await root.submit({ type: "input", content: prompt }, context)).wait(context)).status).toBe(
				"done",
			);
		expect(await readFile(join(directory, "first.txt"), "utf8")).toBe("first");
		expect(await readFile(join(directory, "second.txt"), "utf8")).toBe("second");
		const messages = (await allEntries(root)).flatMap((entry) => [...(entry.model ?? [])]);
		expect(toolIntents(messages)).toEqual({});
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("summaries use the declaration at each call and ignore business descriptions", () => {
	const annotated = Type.Object({ description: Type.Optional(Type.String()) }, { [TOOL_INTENT]: true });
	const unmarked = Type.Object({ description: Type.String() });
	const declaration = (parameters: typeof annotated | typeof unmarked): Message => ({
		role: "system",
		content: "",
		timestamp: 1,
		toolsAdded: [{ name: "example", description: "example", parameters }],
	});
	const call = (id: string, description: unknown): Message =>
		fauxAssistantMessage(fauxToolCall("example", { description }, { id }));
	const messages = [
		declaration(annotated),
		call("first", "  第一行\n第二行  "),
		call("invalid", 1),
		call("empty", " "),
		call("long", "😀".repeat(200)),
		declaration(unmarked),
		call("business", "ordinary business value"),
	];
	expect(toolIntents(messages)).toEqual({ first: "第一行 第二行", long: "😀".repeat(160) });
	expect(modelParameters(unmarked)).toBe(unmarked);
});

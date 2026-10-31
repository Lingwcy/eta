import { type Static, Type } from "typebox";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import { intentParameter, TOOL_INTENT } from "../harness/tool-intent.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { completeFileChange, fileChangeBaseline, prepareFileChange, type FileChangeRecorder, type FileChangeReference } from "./file-change.ts";
import { resolveToolPath } from "./path-utils.ts";

const writeSchema = Type.Object(
	{
		description: intentParameter,
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({ description: "Content to write to the file" }),
	},
	{ [TOOL_INTENT]: true },
);

export type WriteToolInput = Static<typeof writeSchema>;

export type WriteToolDetails = { fileChange?: FileChangeReference };

export function createWriteTool(options: { fileChanges?: FileChangeRecorder } = {}): ToolRegistration<typeof writeSchema, WriteToolDetails> {
	return defineTool({
		name: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(args, api, context) {
			const { path, content } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const capture = options.fileChanges ? await prepareFileChange(
						options.fileChanges, path, await fileChangeBaseline(env, absolutePath, context), content, api, context,
					) : undefined;
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					getOrThrow(await env.writeFile(absolutePath, content, context));
					const fileChange = await completeFileChange(capture, api);
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					return { output: [{ type: "text", text: `Successfully wrote to ${path}` }], ...(fileChange ? { details: { fileChange } } : {}) };
				},
				context,
			);
		},
	});
}

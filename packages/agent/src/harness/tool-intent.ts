import type { Message, Tool, TSchema } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Opt in explicitly; business parameters named description are not display metadata. */
export const TOOL_INTENT = "x-eta-tool-intent";
export const intentParameter = Type.Optional(
	Type.String({
		description:
			"A concise action summary in the user's conversation language. Generate description first, before other parameters. Describe the action without claiming success. Prefer 3–7 English words or a short Chinese phrase.",
	}),
);

export function supportsIntent(parameters: TSchema): boolean {
	return TOOL_INTENT in parameters && parameters[TOOL_INTENT] === true;
}

/** New model requests require a summary; execution keeps accepting older calls without one. */
export function modelParameters(parameters: TSchema): TSchema {
	if (!supportsIntent(parameters)) return parameters;
	const required =
		"required" in parameters && Array.isArray(parameters.required)
			? parameters.required.filter((value): value is string => typeof value === "string")
			: [];
	return { ...parameters, required: [...new Set(["description", ...required])] };
}

/** Display text only; callers retain the complete original arguments. */
export function intentText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/gu, " ").trim();
	return text ? Array.from(text).slice(0, 160).join("") : undefined;
}

/** Resolve each call against its persisted declaration, including declarations replaced later. */
export function toolIntents(messages: readonly Message[], streaming?: Message): Record<string, string> {
	const enabled = new Map<string, boolean>();
	const intents = new Map<string, string>();
	for (const message of [...messages, ...(streaming ? [streaming] : [])]) {
		if (message.role === "system") {
			for (const tool of message.toolsRemoved ?? []) enabled.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) enabled.set(tool.name, supportsIntent(tool.parameters));
		} else if (message.role === "assistant") {
			for (const call of message.content) {
				if (call.type !== "toolCall") continue;
				// Provider call IDs may repeat across turns; the latest call owns its summary.
				intents.delete(call.id);
				if (!enabled.get(call.name)) continue;
				const description = intentText(call.arguments.description);
				if (description) intents.set(call.id, description);
			}
		}
	}
	return Object.fromEntries(intents);
}

export function modelTool(tool: Tool): Tool {
	return { ...tool, parameters: modelParameters(tool.parameters) };
}

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { ExecutionEnv } from "../env/index.ts";
import type { ToolExecutionApi } from "../harness/types.ts";

export const FILE_CHANGE_MAX_BYTES = 512 * 1024;
const MAX_LINES = 20_000;
const encoder = new TextEncoder();

export type FileChangeReference = {
	id: string;
	path: string;
	status: "recorded" | "no-change" | "unavailable" | "too-large" | "uncertain";
};

export type FileChangeContent =
	| { status: "ready"; path: string; patch: string; noChange: boolean }
	| { status: "unavailable"; reason: "binary" | "too-large" | "symlink" | "not-recorded" };

export interface FileChangeCapture {
	readonly reference: FileChangeReference;
	/** Confirm an actual successful write, independently of a subsequently cancelled tool. */
	applied(): Promise<FileChangeReference>;
}

/** A host-owned durable store. Failures must not turn an already applied write into a retryable failure. */
export type FileChangeRecorder = (
	content: FileChangeContent,
	path: string,
	api: ToolExecutionApi,
	context: Context,
) => Promise<FileChangeCapture>;

export type FileChangeBaseline =
	| { status: "ready"; content: string | null }
	| Extract<FileChangeContent, { status: "unavailable" }>;

/** Read only a bounded regular UTF-8 file, preserving BOM and CRLF; absence is not an empty file. */
export async function fileChangeBaseline(env: ExecutionEnv, path: string, context: Context): Promise<FileChangeBaseline> {
	try {
		const info = await env.fileInfo(path, context);
		if (!info.ok) return info.error.code === "not_found"
			? { status: "ready", content: null }
			: { status: "unavailable", reason: "not-recorded" };
		if (info.value.kind !== "file") return { status: "unavailable", reason: info.value.kind === "symlink" ? "symlink" : "not-recorded" };
		if (info.value.size > FILE_CHANGE_MAX_BYTES) return { status: "unavailable", reason: "too-large" };
		const opened = await env.openBinaryReader(path, { noFollow: true }, context);
		if (!opened.ok) return { status: "unavailable", reason: "not-recorded" };
		try {
			const bytes = await opened.value.read(0, FILE_CHANGE_MAX_BYTES + 1, context);
			if (!bytes.ok) return { status: "unavailable", reason: "not-recorded" };
			if (bytes.value.length > FILE_CHANGE_MAX_BYTES) return { status: "unavailable", reason: "too-large" };
			if (bytes.value.includes(0)) return { status: "unavailable", reason: "binary" };
			try {
				return { status: "ready", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.value) };
			} catch { return { status: "unavailable", reason: "binary" }; }
		} finally { await opened.value.close(BACKGROUND_CONTEXT); }
	} catch { return { status: "unavailable", reason: "not-recorded" }; }
}

function changeContent(path: string, before: FileChangeBaseline, after: string): FileChangeContent {
	if (before.status === "unavailable") return before;
	if (after.length > FILE_CHANGE_MAX_BYTES || (before.content?.length ?? 0) > FILE_CHANGE_MAX_BYTES) return { status: "unavailable", reason: "too-large" };
	const bytes = encoder.encode(after);
	if (bytes.byteLength > FILE_CHANGE_MAX_BYTES) return { status: "unavailable", reason: "too-large" };
	if (bytes.includes(0)) return { status: "unavailable", reason: "binary" };
	// Node writes UTF-8 bytes; normalize lone UTF-16 surrogates the same way without stripping a BOM.
	const actualAfter = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
	const old = before.content ?? "";
	if (old.split("\n").length > MAX_LINES || actualAfter.split("\n").length > MAX_LINES) return { status: "unavailable", reason: "too-large" };
	const noChange = before.content !== null && old === actualAfter;
	// Quote path headers so tabs and newlines cannot invent patch records. The source path is separate metadata.
	const label = JSON.stringify(path);
	const patch = createTwoFilesPatch(before.content === null ? "/dev/null" : label, label, old, actualAfter, undefined, undefined, {
		context: 4, headerOptions: FILE_HEADERS_ONLY, timeout: 100, maxEditLength: 40_000,
	});
	if (patch === undefined || encoder.encode(patch).byteLength > 2 * FILE_CHANGE_MAX_BYTES) return { status: "unavailable", reason: "too-large" };
	return { status: "ready", path, patch, noChange };
}

/** Prepare evidence before the write and publish a small live reference; capture is optional for non-Eta hosts. */
export async function prepareFileChange(
	recorder: FileChangeRecorder | undefined,
	path: string,
	before: FileChangeBaseline,
	after: string,
	api: ToolExecutionApi,
	context: Context,
): Promise<FileChangeCapture | undefined> {
	if (!recorder) return undefined;
	let capture: FileChangeCapture;
	try { capture = await recorder(changeContent(path, before, after), path, api, context); }
	catch { return undefined; }
	try { await api.details({ fileChange: capture.reference }, context); } catch {}
	return capture;
}

/** Recording errors after write must never prompt the caller to replay the file operation. */
export async function completeFileChange(capture: FileChangeCapture | undefined, api: ToolExecutionApi): Promise<FileChangeReference | undefined> {
	if (!capture) return undefined;
	let reference: FileChangeReference;
	try { reference = await capture.applied(); }
	catch { reference = { ...capture.reference, status: "uncertain" }; }
	try { await api.details({ fileChange: reference }, BACKGROUND_CONTEXT); } catch {}
	return reference;
}

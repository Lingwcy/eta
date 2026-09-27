import type { Context } from "./context.ts";
import type { TruncationResult } from "./utils/truncate.ts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ImageContent,
  JsonValue,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  TranscriptContext,
  Transport,
  Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}

/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined<TValue extends object, TError>(
  result: Result<TValue, TError>,
): TValue | undefined {
  return result.ok ? result.value : undefined;
}

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/**
 * Skill loaded from a `SKILL.md` file or provided by an application.
 *
 * `name`, `description`, and `filePath` are inserted into the system prompt in an XML-formatted block as suggested by agentskills.io.
 * Use {@link formatSkillsForSystemPrompt} to generate the spec-compatible system prompt block.
 */
export interface Skill {
  /** Stable skill name used for lookup and model-visible listings. */
  name: string;
  /** Short model-visible description of when to use the skill. */
  description: string;
  /** Full skill instructions. */
  content: string;
  /** Absolute path to the skill file. Used for model-visible location and resolving relative references. */
  filePath: string;
  /** Exclude this skill from model-visible skill lists while still allowing explicit application invocation. */
  disableModelInvocation?: boolean;
}

/** Prompt template that can be formatted into a prompt for explicit invocation. */
export interface PromptTemplate {
  /** Stable template name used for lookup or application command routing. */
  name: string;
  /** Optional description for command lists or autocomplete. */
  description?: string;
  /** Template content. Argument placeholders are formatted by `formatPromptTemplateInvocation`. */
  content: string;
}

/** Resources made available to explicit invocation methods and system-prompt callbacks. */
export interface AgentHarnessResources<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
  /** Prompt templates available for explicit invocation. */
  promptTemplates?: TPromptTemplate[];
  /** Skills available to the model and explicit skill invocation. */
  skills?: TSkill[];
}

/** Options for one live harness tool progress update. */
export interface AgentHarnessToolUpdateOptions {
  /** Request replacement of this invocation's durable recovery checkpoint. */
  checkpoint?: true;
}

/** Synchronous full-snapshot progress callback supplied to harness-native tools. */
export type AgentHarnessToolUpdateCallback<TDetails> = (
  partialResult: AgentToolResult<TDetails>,
  options?: AgentHarnessToolUpdateOptions,
) => void;

/** Stable harness identity for one logical tool call, unchanged during safe replay. */
export interface AgentHarnessToolInvocation {
  /** Opaque session-unique id equal to the call's reserved result-entry id. */
  readonly invocationId: string;
  readonly operationId: string;
  readonly turnId: string;
  /** Read one invocation-scoped durable replay memo. */
  getMemo(name: string): Promise<JsonValue | undefined>;
  /** Set or delete one invocation-scoped durable replay memo. */
  setMemo(name: string, value: JsonValue | undefined): Promise<void>;
}

/** Tool definition executed by an {@link AgentHarness} with an application-defined context. */
export type AgentHarnessTool<
  TContext extends object | undefined,
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> = Omit<AgentTool<TParameters, TDetails>, "execute"> & {
  /** Execute the tool call with the context resolved for the current turn snapshot. */
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    onUpdate: AgentHarnessToolUpdateCallback<TDetails>,
    toolContext: TContext,
    invocation: AgentHarnessToolInvocation,
    context: Context,
  ): Promise<AgentToolResult<TDetails>>;
};

/** Static tool context or provider resolved for each turn snapshot. */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
  | TContext
  | ((context: Context) => TContext | Promise<TContext>);

/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
  /** Preferred transport forwarded to the stream function. */
  transport?: Transport;
  /** Provider request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum provider retry attempts. */
  maxRetries?: number;
  /** Optional cap for provider-requested retry delays. */
  maxRetryDelayMs?: number;
  /** Additional request headers merged with auth and lifecycle headers. */
  headers?: Record<string, string>;
  /** Provider metadata forwarded with requests. */
  metadata?: SimpleStreamOptions["metadata"];
  /** Provider cache retention hint. */
  cacheRetention?: SimpleStreamOptions["cacheRetention"];
  /** Ask a capable provider to continue generation asynchronously. */
  deferred?: boolean | { window?: "15m" | "1h" | "24h" };
}

/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch extends Omit<
  Partial<AgentHarnessStreamOptions>,
  "headers" | "metadata"
> {
  /** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
  headers?: Record<string, string | undefined>;
  /** Metadata patch. `undefined` values delete keys; explicit `metadata: undefined` clears all metadata. */
  metadata?: Record<string, unknown | undefined>;
}

/** Kind of filesystem object as addressed by a {@link FileSystem}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent file error codes returned by {@link FileSystem} file operations. */
export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
  /** Backend-independent error code. */
  public code: FileErrorCode;
  /** Absolute addressed path associated with the failure, when available. */
  public path?: string;

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
}

/** Stable, backend-independent execution error codes returned by {@link ExecutionEnv.exec}. */
export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown";

/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
  /** Backend-independent error code. */
  public code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionError";
    this.code = code;
  }
}

/** Stable compaction error codes returned by compaction helpers. */
export type CompactionErrorCode = "aborted" | "summarization_failed";

/** Error returned by compaction helpers. */
export class CompactionError extends Error {
  /** Backend-independent error code. */
  public code: CompactionErrorCode;

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}

/** Stable branch-summary error codes returned by branch summarization helpers. */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed";

/** Error returned by branch summarization helpers. */
export class BranchSummaryError extends Error {
  /** Backend-independent error code. */
  public code: BranchSummaryErrorCode;

  constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BranchSummaryError";
    this.code = code;
  }
}

/** Metadata for one filesystem object in a {@link FileSystem}. */
export interface FileInfo {
  /** Basename of {@link path}. */
  name: string;
  /** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
  path: string;
  /** Object kind. Symlink targets are not followed; use {@link FileSystem.canonicalPath} explicitly. */
  kind: FileKind;
  /** Size in bytes for the addressed filesystem object. */
  size: number;
  /** Modification time as milliseconds since Unix epoch. */
  mtimeMs: number;
}

/** One UTF-8 line read from a text file. */
export interface TextLine {
  text: string;
  /** Whether the line ended with `\n`; callers use this to discard a torn final record. */
  terminated: boolean;
}

/** Pull-based UTF-8 line reader that preserves final-line termination. */
export interface TextLineReader {
  readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
  /** Release the open file. Must be best-effort and must not throw or reject. */
  close(context: Context): Promise<void>;
}

/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Paths returned by file operations are addressed paths
 * in the filesystem namespace, but are not canonicalized through symlinks unless returned by {@link canonicalPath}.
 *
 * Operation methods must never throw or reject. All filesystem failures, including unexpected backend failures, must be
 * encoded in the returned {@link Result}. Implementations must preserve this invariant.
 */
export interface FileSystem {
  /** Current working directory for relative paths. */
  cwd: string;

  /** Return an absolute addressed path without requiring it to exist and without resolving symlinks. */
  absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
  /** Join path segments in the filesystem namespace without requiring the result to exist. */
  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
  /** Read a UTF-8 text file. */
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
  /** Open a UTF-8 text file for pull-based line reading. */
  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>>;
  /** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>>;
  /** Read a binary file. */
  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
  /** Create or overwrite a file, creating parent directories when supported. */
  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Create or append to a file, creating parent directories when supported. */
  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Atomically rename a file, replacing the destination when it exists. Does not copy across filesystems. */
  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Return metadata for the addressed path without following symlinks. */
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
  /** List direct children of a directory without following symlinks. */
  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
  /** Return the canonical path for an existing path, resolving symlinks where supported. */
  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
  /** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
  exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
  /** Create a directory. Defaults to `recursive: true`. */
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Remove a file or directory. Defaults to `recursive: false` and `force: false`. */
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Create a temporary directory and return its absolute path. Defaults to `prefix: "tmp-"`. */
  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
  /** Create a temporary file and return its absolute path. Defaults to `prefix: ""` and `suffix: ""`. */
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>>;

  /** Release filesystem resources. Must be best-effort and must not throw or reject. */
  cleanup(context: Context): Promise<void>;
}

/** Which portion of bounded output survives after the limit is crossed. */
export type ShellOutputRetention = "head" | "tail";

/** Source-side limits for one combined shell output view. */
export interface ShellOutputLimits {
  maxBytes: number;
  maxLines: number;
  /** Defaults to `"tail"`. */
  retain?: ShellOutputRetention;
}

/** Bounded shell capture requested by the caller. */
export interface ShellOutputCaptureOptions {
  limits: ShellOutputLimits;
  /** Preserve complete output in an execution-environment-local file after the limits are crossed. */
  spill?: boolean;
}

/** Truncation metadata without a duplicate copy of the retained text. */
export type ShellOutputTruncation = Omit<TruncationResult, "content">;

/** Metadata accompanying a bounded shell output view. */
export interface ShellOutputMetadata {
  truncation: ShellOutputTruncation;
  spillPath?: string;
  lastLineBytes?: number;
}

/** Complete bounded shell output view. */
export interface ShellOutputView extends ShellOutputMetadata {
  text: string;
}

/** Incremental source-side change to one bounded shell output view. */
export type ShellOutputUpdate =
  | { kind: "replace"; output: ShellOutputView }
  | { kind: "append"; text: string; metadata: ShellOutputMetadata }
  | { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
  | { kind: "metadata"; metadata: ShellOutputMetadata };

/** Bounded shell completion. Output text is delivered through {@link ShellExecOptions.onUpdate}. */
export interface ShellExecResult extends ShellOutputMetadata {
  exitCode: number;
}

/** Options for {@link Shell.exec}. */
export interface ShellExecOptions {
  /** Working directory for the command. Relative paths are resolved against {@link ExecutionEnv.cwd}. Defaults to {@link ExecutionEnv.cwd}. */
  cwd?: string;
  /** Environment variables for the command. Values override inherited defaults when `inheritEnv` is true. */
  env?: Record<string, string>;
  /** Whether to inherit the execution environment's default variables. Defaults to true. */
  inheritEnv?: boolean;
  /** Timeout in seconds. Implementations should return a timeout error when the command exceeds this duration. Defaults to no timeout. */
  timeout?: number;
  /** Source-side bounded capture. Output is discarded when this and `onUpdate` are both absent. */
  capture?: ShellOutputCaptureOptions;
  /** Called with bounded output changes. */
  onUpdate?: (update: ShellOutputUpdate, context: Context) => void;
}

/** Shell execution capability used by the harness. */
export interface Shell {
  /** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>>;
  /** Release shell resources. Must be best-effort and must not throw or reject. */
  cleanup(context: Context): Promise<void>;
}

/** Filesystem and process execution environment used by the harness. */
export interface ExecutionEnv extends FileSystem, Shell {}

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * The loop passes a normalized transcript: the system prompt and tool
 * declarations are carried by the transcript's system messages, never by
 * `context.systemPrompt` or `context.tools`.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /**
   * Hint that the agent should stop after the current tool batch when this call is blocked.
   * Early termination only happens when every finalized tool result in the batch sets this to true.
   */
  terminate?: boolean;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `usage`: if provided, replaces the tool result usage
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content`, `details`, or `usage`.
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  /** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
  usage?: Usage;
  /**
   * Hint that the agent should stop after the current tool batch.
   * Early termination only happens when every finalized tool result in the batch sets this to true.
   */
  terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
  /** The assistant message that requested the tool call. */
  assistantMessage: AssistantMessage;
  /** The raw tool call block from `assistantMessage.content`. */
  toolCall: AgentToolCall;
  /** Validated tool arguments for the target tool schema. */
  args: unknown;
  /** Current agent context at the time the tool call is prepared. */
  context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
  /** The assistant message that requested the tool call. */
  assistantMessage: AssistantMessage;
  /** The raw tool call block from `assistantMessage.content`. */
  toolCall: AgentToolCall;
  /** Validated tool arguments for the target tool schema. */
  args: unknown;
  /** The executed tool result before any `afterToolCall` overrides are applied. */
  result: AgentToolResult<any>;
  /** Whether the executed tool result is currently treated as an error. */
  isError: boolean;
  /** Current agent context at the time the tool call is finalized. */
  context: AgentContext;
}

/** Context passed to completed-turn callbacks. */
export interface AgentTurnContext {
  /** The assistant message that completed the turn. */
  message: AssistantMessage;
  /** Tool result messages emitted for the completed turn. */
  toolResults: ToolResultMessage[];
  /** Current agent context after the turn's assistant message and tool results have been appended. */
  context: AgentContext;
  /** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
  newMessages: AgentMessage[];
}

/** Decision returned by {@link FinishTurn}. Returning undefined preserves normal scheduling. */
export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * Called after a completed assistant turn and all of its tool-result messages, but before `turn_end`.
 * On a normal turn, `{ action: "continue" }` ensures one next provider request. Tool-result, steering, or
 * follow-up scheduling can satisfy that request and adds no extra request; otherwise the loop continues once
 * with the current context. Error and aborted responses remain hard exits.
 */
export type FinishTurn = (
  turn: AgentTurnContext,
  signal?: AbortSignal,
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
  /** Context for the next provider request. */
  context?: AgentContext;
  /** Messages to append before the next provider request, with normal lifecycle events. */
  messages?: AgentMessage[];
  /** Model for the next provider request. */
  model?: Model<any>;
  /** Thinking level for the next provider request. */
  thinkingLevel?: ThinkingLevel;
}

/** Runtime state available immediately before a conversational provider request. */
export interface PrepareRequestContext {
  context: AgentContext;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
}

/** Replacement runtime state for the provider request being prepared. */
export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/**
 * Called immediately before every conversational provider request, including the first.
 * Pending messages have already been appended and emitted when this callback runs.
 */
export type PrepareRequest = (
  request: PrepareRequestContext,
  signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface PrepareNextTurnContext extends AgentTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;

  /**
   * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
   *
   * Each AgentMessage must be converted to a SystemMessage, UserMessage, AssistantMessage, or ToolResultMessage
   * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
   * status messages) should be filtered out.
   *
   * Contract: must not throw or reject. Return a safe fallback value instead.
   * Throwing interrupts the low-level agent loop without producing a normal event sequence.
   *
   * @example
   * ```typescript
   * convertToLlm: (messages) => messages.flatMap(m => {
   *   if (m.role === "custom") {
   *     // Convert custom message to user message
   *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
   *   }
   *   if (m.role === "notification") {
   *     // Filter out UI-only messages
   *     return [];
   *   }
   *   // Pass through standard LLM messages
   *   return [m];
   * })
   * ```
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  /**
   * Optional transform applied to the context before `convertToLlm`.
   *
   * Use this for operations that work at the AgentMessage level:
   * - Context window management (pruning old messages)
   * - Injecting context from external sources
   *
   * Contract: must not throw or reject. Return the original messages or another
   * safe fallback value instead.
   *
   * @example
   * ```typescript
   * transformContext: async (messages) => {
   *   if (estimateTokens(messages) > MAX_TOKENS) {
   *     return pruneOldMessages(messages);
   *   }
   *   return messages;
   * }
   * ```
   */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  /**
   * Resolves an API key dynamically for each LLM call.
   *
   * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
   * during long-running tool execution phases.
   *
   * Contract: must not throw or reject. Return undefined when no key is available.
   */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  /**
   * Called after the assistant message and all tool-result messages have been emitted, immediately before `turn_end`.
   * `{ action: "end" }` ends the run without polling queues or preparing another request.
   * On a normal turn, `{ action: "continue" }` ensures one next provider request. Tool-result, steering, or
   * follow-up scheduling can satisfy that request and adds no extra request; otherwise the loop continues once
   * with the current context. Returning undefined preserves normal scheduling. Error and aborted responses remain
   * hard exits.
   */
  finishTurn?: FinishTurn;

  /**
   * Called immediately before every conversational provider request, including the first.
   * Pending messages have already been appended. The returned context, model, and thinking level
   * replace the runtime values for this and later requests in the run. This hook does not poll queues.
   */
  prepareRequest?: PrepareRequest;

  /**
   * Called after `turn_end` when the loop will continue, immediately before the next turn starts.
   * Return replacement context/model/thinking state or messages to append to affect that turn.
   * Return undefined to keep using the current context/config.
   */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

  /**
   * Returns steering messages to inject into the conversation mid-run.
   *
   * Called after the current assistant turn finishes executing its tool calls, unless `finishTurn` ends the run.
   * If messages are returned, they are added to the context before the next LLM call.
   * Tool calls from the current assistant message are not skipped.
   *
   * Use this for "steering" the agent while it's working.
   *
   * Contract: must not throw or reject. Return [] when no steering messages are available.
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  /**
   * Returns follow-up messages to process after the agent would otherwise stop.
   *
   * Called when the agent has no more tool calls and no steering messages.
   * If messages are returned, they're added to the context and the agent
   * continues with another turn.
   *
   * Use this for follow-up messages that should wait until the agent finishes.
   *
   * Contract: must not throw or reject. Return [] when no follow-up messages are available.
   */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;

  /**
   * Tool execution mode.
   * - "sequential": execute tool calls one by one
   * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
   *   emit `tool_execution_end` in tool completion order after each tool is finalized,
   *   then emit tool-result message artifacts later in assistant source order
   *
   * Default: "parallel"
   */
  toolExecution?: ToolExecutionMode;

  /**
   * Called before a tool is executed, after arguments have been validated.
   *
   * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
   * A blocked result can also set `terminate: true` to participate in the batch early-termination rule.
   * The hook receives the agent abort signal and is responsible for honoring it.
   */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;

  /**
   * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
   *
   * Return an `AfterToolCallResult` to override parts of the executed tool result:
   * - `content` replaces the full content array
   * - `details` replaces the full details payload
   * - `isError` replaces the error flag
   * - `usage` replaces the tool result usage
   * - `terminate` replaces the early-termination hint
   *
   * Any omitted fields keep their original values. No deep merge is performed.
   * The hook receives the agent abort signal and is responsible for honoring it.
   */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @earendil-works/pi-ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
  // Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
  /**
   * Current system prompt, replayed from the transcript's system messages.
   *
   * Read-only: to change the prompt, append a system message with `content` or `sections`.
   * In `initialState`, this seeds the leading system message.
   */
  readonly systemPrompt: string;
  /** Active model used for future turns. */
  model: Model<any>;
  /** Requested reasoning level for future turns. */
  thinkingLevel: ThinkingLevel;
  /**
   * Executable tools. Assigning a new array copies the top-level array.
   *
   * Differences from the tools declared in the transcript are announced to the model
   * with a system message before the next request.
   */
  set tools(tools: AgentTool<any>[]);
  get tools(): AgentTool<any>[];
  /**
   * Conversation transcript. Assigning a new array copies the top-level array.
   *
   * System messages in the transcript carry the prompt and tool declarations.
   */
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
  /**
   * True while the agent is processing a prompt or continuation.
   *
   * This remains true until awaited `agent_end` listeners settle.
   */
  readonly isStreaming: boolean;
  /** Partial assistant message for the current streamed response, if any. */
  readonly streamingMessage?: AgentMessage;
  /** Tool call ids currently executing. */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** Error message from the most recent failed or aborted assistant turn, if any. */
  readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T = JsonValue | undefined> {
  /** Text or image content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: T;
  /** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
  usage?: Usage;
  /**
   * Hint that the agent should stop after the current tool batch.
   * Early termination only happens when every finalized tool result in the batch sets this to true.
   */
  terminate?: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  /** Human-readable label for UI display. */
  label: string;
  /**
   * Optional compatibility shim for raw tool-call arguments before schema validation.
   * Must return an object that matches `TParameters`.
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
  replay?: "never" | "safe";
  /**
   * Per-tool execution mode override.
   * - "sequential": this tool must execute one at a time with other tool calls.
   * - "parallel": this tool can execute concurrently with other tool calls.
   *
   * If omitted, the default execution mode applies.
   */
  executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
  /** Transcript visible to the model. */
  messages: AgentMessage[];
  /** Tools available for execution in this run. */
  tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle - a turn is one assistant response + any tool calls/results
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle - emitted for system, user, assistant, and toolResult messages
  | { type: "message_start"; message: AgentMessage }
  // Only emitted for assistant messages during streaming
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };

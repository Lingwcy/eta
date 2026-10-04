import { isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import { validateCatalog } from "./invariants.ts";
import type { CatalogState } from "./type.ts";

export const CATALOG_VERSION = 1;

const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const AbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter(isAbsolute, { message: "Expected an absolute path" }),
);

const ProjectSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  environmentId: Schema.Literal("local"),
  name: Schema.NonEmptyString,
  rootPath: AbsolutePath,
  createdAt: Timestamp,
});

const WorkspaceSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  cwd: AbsolutePath,
  kind: Schema.Literals(["project-root", "worktree"]),
  createdAt: Timestamp,
});

const ThreadSchema = Schema.Struct({
  projectId: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  id: Schema.NonEmptyString,
  workspaceId: Schema.NonEmptyString,
  sessionRef: Schema.Struct({
    backendId: Schema.Literal("eta"),
    metadata: Schema.Struct({
      id: Schema.NonEmptyString,
      createdAt: Timestamp,
      storageVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      cwd: AbsolutePath,
      path: AbsolutePath,
      modifiedAt: Timestamp,
      parentSessionId: Schema.optionalKey(Schema.NonEmptyString),
      legacyParentSessionPath: Schema.optionalKey(AbsolutePath),
    }),
  }),
  archivedAt: Schema.optionalKey(Timestamp),
  title: Schema.String,
  createdAt: Timestamp,
});

export const CatalogSchema = Schema.Struct({
  version: Schema.Literal(CATALOG_VERSION),
  projects: Schema.Array(ProjectSchema),
  workspaces: Schema.Array(WorkspaceSchema),
  threads: Schema.Array(ThreadSchema),
});

export class CatalogValidationError extends Schema.TaggedError<CatalogValidationError>()(
  "CatalogValidationError",
  {
    reason: Schema.Literals([
      "InvalidJson",
      "UnsupportedVersion",
      "InvalidFields",
      "InvalidRelations",
    ]),
    message: Schema.String,
  },
) {}

const decodeVersion = Schema.decodeUnknownEffect(Schema.Struct({ version: Schema.Int }));
const decodeFields = Schema.decodeUnknownEffect(CatalogSchema, {
  onExcessProperty: "error",
  errors: "all",
});

/**
 * 通过未知结构解码类目并进行关系检查
 * @returns 验证过的合法state
 */
export const decodeCatalog = Effect.fn("decodeCatalog")(function* (input: unknown) {
  const { version } = yield* decodeVersion(input).pipe(
    Effect.mapError(
      (error) => new CatalogValidationError({ reason: "InvalidFields", message: error.message }),
    ),
  );
  if (version !== CATALOG_VERSION) {
    return yield* new CatalogValidationError({
      reason: "UnsupportedVersion",
      message: `${version}是我们不支持的类目版本; 预期 ${CATALOG_VERSION}.`,
    });
  }
  const { projects, workspaces, threads } = yield* decodeFields(input).pipe(
    Effect.mapError(
      (error) => new CatalogValidationError({ reason: "InvalidFields", message: error.message }),
    ),
  );
  const state = { projects, workspaces, threads } satisfies CatalogState;
  const violations = validateCatalog(state);
  if (violations.length > 0) {
    return yield* new CatalogValidationError({
      reason: "InvalidRelations",
      message: violations.map(({ code, message }) => `${code}: ${message}`).join("\n"),
    });
  }
  return state;
});

/**
 * 反序列化解码类目
 * 解码从磁盘读取的 .json 文件的原始内容
 */
export const parseCatalog = Effect.fn("parseCatalog")(function* (text: string) {
  const input: unknown = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => new CatalogValidationError({ reason: "InvalidJson", message: String(cause) }),
  });
  return yield* decodeCatalog(input);
});

/**
 * 序列号编码类目
 * 将内存中的类目编码为可存储的json
 */
export const encodeCatalog = Effect.fn("encodeCatalog")(function* (state: CatalogState) {
  const valid = yield* decodeCatalog({ version: CATALOG_VERSION, ...state });
  return `${JSON.stringify({ version: CATALOG_VERSION, ...valid }, null, 2)}\n`;
});

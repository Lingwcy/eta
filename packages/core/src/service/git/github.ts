import { Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { GitRepositoryService } from "./index.ts";
import { WorkspaceService } from "../workspaces/index.ts";
import { CoreEnvironmentService } from "../environment.ts";
import { CoreError, adapter } from "../errors.ts";
import { defaultGitHubAdapter } from "../../platform/github.ts";
import type { GitHubSession, GitHubResponse } from "../../platform/github.ts";
import type {
  GitHubIdentity,
  GitHubPage,
  GitHubQuery,
  GitHubRepositoryContext,
  GitHubItem,
} from "../../shared/github.ts";

const Row = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  updated_at: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  draft: Schema.optionalKey(Schema.Boolean),
  merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head: Schema.optionalKey(Schema.Struct({ ref: Schema.String })),
  base: Schema.optionalKey(Schema.Struct({ ref: Schema.String })),
  labels: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
  pull_request: Schema.optionalKey(Schema.Unknown),
});
const decode = Schema.decodeUnknownSync(Schema.Array(Row));
const FRESH_MS = 60_000;

/** Repository selection and pagination stay on the host; network queries never hold a Git write lock. */
export class GitHubRepositoryService extends Context.Service<
  GitHubRepositoryService,
  {
    identity(): Effect.Effect<GitHubIdentity, CoreError>;
    query(input: GitHubQuery): Effect.Effect<GitHubPage, CoreError>;
  }
>()("eta/core/git/GitHubRepositoryService") {
  static readonly layer = Layer.effect(
    GitHubRepositoryService,
    Effect.gen(function* () {
      const git = yield* GitRepositoryService;
      const workspaces = yield* WorkspaceService;
      const environment = yield* CoreEnvironmentService;
      const transport = environment.github ?? defaultGitHubAdapter;
      const cache = new Map<string, Extract<GitHubPage, { status: "ready" }>>();
      const failures = new Map<string, Extract<GitHubPage, { status: "error" }>>();
      const pending = new Map<string, Promise<GitHubPage>>();
      const identities = new Map<string, string>();
      const rateLimits = new Map<string, number>();
      const identityIds = new Map<string, string>();
      const publicIdentity = (session: GitHubSession): GitHubIdentity => {
        const revision = identityIds.get(session.key) ?? randomUUID();
        identityIds.set(session.key, revision);
        return { ...session.identity, revision };
      };
      const request = async (
        session: GitHubSession,
        repository: GitHubRepositoryContext,
        input: GitHubQuery,
        key: string,
        page: number,
      ): Promise<GitHubPage> => {
        const cached = cache.get(key);
        const failure = (
          code: Extract<GitHubPage, { status: "error" }>["code"],
          message: string,
          retryAt?: number,
        ): GitHubPage => ({
          status: "error",
          code,
          message,
          repository,
          identity: publicIdentity(session),
          ...(retryAt ? { retryAt } : {}),
          ...(cached && ["network", "rate-limit", "unavailable"].includes(code)
            ? { cached: { ...cached, stale: true } }
            : {}),
        });
        try {
          const items: GitHubItem[] = [];
          let next: number | undefined = page;
          // Issues pages containing only PRs are skipped, with a bound to keep one request finite.
          for (let attempts = 0; next && attempts < 5 && !items.length; attempts++) {
            const path = `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${input.kind}?state=${input.state}&sort=updated&direction=desc&per_page=30&page=${next}`;
            const response: GitHubResponse = await session.request(path);
            if (response.status !== 200) {
              if (
                response.status === 429 ||
                (response.status === 403 &&
                  (response.headers["x-ratelimit-remaining"] === "0" ||
                    response.headers["retry-after"]))
              ) {
                const retryAt = response.headers["retry-after"]
                  ? Date.now() + Number(response.headers["retry-after"]) * 1000
                  : Number(response.headers["x-ratelimit-reset"]) * 1000 || Date.now() + 60_000;
                const error = failure(
                  "rate-limit",
                  "GitHub 请求达到限额，请在重试时间后刷新。",
                  retryAt,
                );
                if (error.status === "error") failures.set(key, error);
                rateLimits.set(session.key, retryAt);
                return error;
              }
              if (response.status === 401)
                return failure(
                  "unauthenticated",
                  "GitHub 登录已失效，请在宿主重新登录 GitHub CLI。",
                );
              if (response.status === 403 || response.status === 404)
                return failure(
                  session.identity.authenticated ? "access-denied" : "unauthenticated",
                  session.identity.authenticated
                    ? "无法访问此仓库，请检查权限和所选 remote。"
                    : "匿名访问不可用；私有仓库需要在宿主运行 gh auth login。",
                );
              return failure("unavailable", "GitHub 仓库服务暂不可用，请稍后刷新。");
            }
            const rows = decode(response.body);
            for (const row of rows) {
              if (input.kind === "issues" && row.pull_request !== undefined) continue;
              const url = new URL(row.html_url);
              if (url.protocol !== "https:" || url.hostname !== "github.com")
                throw new Error("Invalid GitHub URL");
              items.push({
                number: row.number,
                title: row.title,
                state: row.merged_at ? "merged" : row.state,
                draft: row.draft ?? false,
                author: row.user?.login ?? "unknown",
                updatedAt: row.updated_at,
                url: url.href,
                labels: row.labels.map((label) => (typeof label === "string" ? label : label.name)),
                ...(row.head ? { head: row.head.ref } : {}),
                ...(row.base ? { base: row.base.ref } : {}),
              });
            }
            const link = response.headers.link?.split(",").find((part) => /rel="next"/.test(part));
            const target = link?.match(/<([^>]+)>/)?.[1];
            const candidate = target ? Number(new URL(target).searchParams.get("page")) : undefined;
            next =
              candidate && Number.isSafeInteger(candidate) && candidate > next
                ? candidate
                : undefined;
          }
          // Discard results if this project changed identity while the HTTP request was running.
          if (identities.get(input.projectId) !== session.key)
            return failure("unauthenticated", "GitHub 访问身份已变更，请重新刷新。");
          const latest = await Effect.runPromise(git.repository(repository.workspaceId));
          const selected = latest.status === "ready" && latest.github?.selection;
          if (
            !selected ||
            latest.status !== "ready" ||
            latest.commonDir !== repository.commonDir ||
            selected.remote !== repository.remote ||
            selected.owner !== repository.owner ||
            selected.repo !== repository.repo
          )
            return {
              status: "error",
              code: "selection-required",
              message: "仓库或 remote 已变更，请刷新后重新选择。",
            };
          const value: Extract<GitHubPage, { status: "ready" }> = {
            status: "ready",
            repository,
            identity: publicIdentity(session),
            items: [...new Map(items.map((item) => [item.number, item])).values()],
            ...(next ? { nextCursor: String(next) } : {}),
            fetchedAt: Date.now(),
            stale: false,
          };
          cache.set(key, value);
          failures.delete(key);
          return value;
        } catch {
          return failure("network", "无法读取 GitHub 列表，请检查网络后重试。");
        }
      };
      return GitHubRepositoryService.of({
        identity: () =>
          adapter("无法检查 GitHub 登录状态", async () =>
            publicIdentity(await transport.session()),
          ),
        query: Effect.fn("GitHubRepositoryService.query")(function* (input: GitHubQuery) {
          const root = (yield* workspaces.list(input.projectId)).find(
            (workspace) => workspace.kind === "project-root",
          );
          if (!root) return yield* new CoreError({ code: "NotFound", message: "项目不存在" });
          const info = yield* git.repository(root.id);
          if (info.status !== "ready")
            return {
              status: "error",
              code: "unavailable",
              message: "项目仓库不可用，请检查工作区。",
            };
          const selection = info.github?.selection;
          if (!selection)
            return {
              status: "error",
              code: info.github ? "selection-required" : "not-github",
              message: info.github
                ? "请选择要查看的 GitHub remote。"
                : "该项目没有 GitHub remote。",
            };
          const repository = {
            projectId: input.projectId,
            workspaceId: root.id,
            commonDir: info.commonDir,
            remote: selection.remote,
            owner: selection.owner,
            repo: selection.repo,
          };
          const page = Number(input.cursor ?? 1);
          if (!Number.isSafeInteger(page) || page < 1)
            return yield* new CoreError({ code: "InvalidInput", message: "分页游标无效" });
          const session = yield* adapter("无法检查 GitHub 登录状态", () => transport.session());
          if (identities.get(input.projectId) !== session.key) {
            for (const key of cache.keys())
              if (key.startsWith(`${input.projectId}:`)) cache.delete(key);
            for (const key of failures.keys())
              if (key.startsWith(`${input.projectId}:`)) failures.delete(key);
          }
          identities.set(input.projectId, session.key);
          const key = `${input.projectId}:${JSON.stringify([info.commonDir, selection, session.key, input.kind, input.state, page])}`;
          const limited = failures.get(key);
          if (limited?.retryAt && limited.retryAt > Date.now()) return limited;
          const saved = cache.get(key);
          const retryAt = rateLimits.get(session.key);
          if (retryAt && retryAt > Date.now())
            return {
              status: "error",
              code: "rate-limit",
              message: "GitHub 请求达到限额，请在重试时间后刷新。",
              retryAt,
              repository,
              identity: publicIdentity(session),
              ...(saved ? { cached: { ...saved, stale: true } } : {}),
            };
          if (saved && !input.refresh && Date.now() - saved.fetchedAt < FRESH_MS) return saved;
          let loading = pending.get(key);
          if (!loading) {
            loading = request(session, repository, input, key, page).finally(() =>
              pending.delete(key),
            );
            pending.set(key, loading);
          }
          return yield* Effect.promise(() => loading!);
        }),
      });
    }),
  );
}

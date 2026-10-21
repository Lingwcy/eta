import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore } from "../../../src/client.ts";
import type { CoreClient } from "../../../src/client.ts";
import type { GitHubResponse } from "../../../src/platform/github.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });
const row = (number: number, extra = {}) => ({
  number,
  title: `Item ${number}`,
  state: "open",
  html_url: `https://github.com/owner/repo/issues/${number}`,
  updated_at: "2026-10-13T00:00:00Z",
  user: { login: "author" },
  labels: [],
  ...extra,
});
const response = (body: unknown, headers: Record<string, string> = {}): GitHubResponse => ({
  status: 200,
  headers,
  body,
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-github-"));
  directories.push(directory);
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  await git(cwd, "init", "-q");
  await git(cwd, "remote", "add", "origin", "https://github.com/owner/repo.git");
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const paths: string[] = [];
  let identity = "anonymous";
  let beforeSession: (() => Promise<void>) | undefined;
  let handler: (path: string) => Promise<GitHubResponse> = async () => response([]);
  const core = await createCore({
    dataRoot: join(directory, "data"),
    home: directory,
    models,
    settings: { read: Effect.succeed({ defaultThinkingLevel: "off" }), subscribe: () => () => {} },
    environment: {
      github: {
        session: async () => {
          const current = identity;
          await beforeSession?.();
          return {
            key: current,
            identity: {
              source: current === "anonymous" ? "anonymous" : "gh",
              authenticated: current !== "anonymous",
              ...(current !== "anonymous" ? { login: current } : {}),
            },
            request: async (path) => {
              paths.push(path);
              return handler(path);
            },
          };
        },
      },
    },
  });
  clients.push(core);
  const project = await core.registerProject(cwd);
  const query = { projectId: project.id, kind: "issues" as const, state: "open" as const };
  return {
    core,
    cwd,
    project,
    query,
    paths,
    identity: (key: string) => {
      identity = key;
    },
    handler: (next: typeof handler) => {
      handler = next;
    },
    beforeSession: (next: () => Promise<void>) => {
      beforeSession = next;
    },
  };
}

test("Issue pagination skips PR-only pages and retains continuation instead of ending early", async () => {
  const f = await fixture();
  f.handler(async (path) =>
    path.endsWith("page=1")
      ? response([row(1, { pull_request: {} })], {
          link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"',
        })
      : response([row(2, { labels: [{ name: "bug" }] })], {
          link: '<https://api.github.com/repos/owner/repo/issues?page=3>; rel="next"',
        }),
  );
  expect(await f.core.githubQuery(f.query)).toMatchObject({
    status: "ready",
    items: [{ number: 2, labels: ["bug"] }],
    nextCursor: "3",
  });
  expect(f.paths).toHaveLength(2);
  await f.core.githubQuery(f.query);
  expect(f.paths).toHaveLength(2);
  await f.core.githubQuery({ ...f.query, refresh: true });
  expect(f.paths).toHaveLength(4);
});

test("PR DTOs distinguish merged and draft states and keep head/base", async () => {
  const f = await fixture();
  f.handler(async () =>
    response([
      row(3, {
        state: "closed",
        merged_at: "2026-10-12T00:00:00Z",
        draft: true,
        head: { ref: "feature" },
        base: { ref: "main" },
      }),
    ]),
  );
  expect(await f.core.githubQuery({ ...f.query, kind: "pulls", state: "closed" })).toMatchObject({
    status: "ready",
    items: [{ number: 3, state: "merged", draft: true, head: "feature", base: "main" }],
  });
});

test("cache entries are isolated by identity, remote and state and stale requests are discarded", async () => {
  const f = await fixture();
  f.handler(async () => response([row(1)]));
  await f.core.githubQuery(f.query);
  f.identity("other-user");
  await f.core.githubQuery(f.query);
  expect(f.paths).toHaveLength(2);
  await f.core.githubQuery({ ...f.query, state: "all" });
  expect(f.paths).toHaveLength(3);
  await git(f.cwd, "remote", "add", "upstream", "https://github.com/upstream/other.git");
  await f.core.selectGitHubRemote(f.project.id, "upstream");
  expect(await f.core.githubQuery(f.query)).toMatchObject({
    status: "ready",
    repository: { remote: "upstream", owner: "upstream", repo: "other" },
  });
  let finish!: (value: GitHubResponse) => void;
  f.handler(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = f.core.githubQuery({ ...f.query, refresh: true });
  await expect.poll(() => typeof finish).toBe("function");
  await f.core.selectGitHubRemote(f.project.id, "origin");
  finish(response([row(99)]));
  expect(await loading).toMatchObject({ status: "error", code: "selection-required" });
});

test("rate limits preserve stale data and respect retry deadlines; unauthenticated access has no private cache", async () => {
  const f = await fixture();
  f.handler(async () => response([row(1)]));
  await f.core.githubQuery(f.query);
  f.handler(async () => ({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
    body: {},
  }));
  expect(await f.core.githubQuery({ ...f.query, refresh: true })).toMatchObject({
    status: "error",
    code: "rate-limit",
    cached: { stale: true, items: [{ number: 1 }] },
  });
  const count = f.paths.length;
  await f.core.githubQuery({ ...f.query, refresh: true });
  expect(f.paths).toHaveLength(count);
  f.identity("new-user");
  f.handler(async () => ({ status: 404, headers: {}, body: {} }));
  const unavailable = await f.core.githubQuery(f.query);
  expect(unavailable).toMatchObject({ status: "error", code: "access-denied" });
  expect(unavailable.status === "error" && unavailable.cached).toBeUndefined();
  f.identity("anonymous");
  expect(await f.core.githubQuery(f.query)).toMatchObject({ status: "error", code: "rate-limit" });
  const fresh = await fixture();
  fresh.handler(async () => ({ status: 404, headers: {}, body: {} }));
  expect(await fresh.core.githubQuery(fresh.query)).toMatchObject({
    status: "error",
    code: "unauthenticated",
  });
});

test("an identity replaced during final repository validation cannot publish an old reply", async () => {
  const f = await fixture();
  f.identity("old-user");
  const oldResponse = Promise.withResolvers<GitHubResponse>();
  const replacementSession = Promise.withResolvers<void>();
  let replacementWaiting = false;
  let requests = 0;
  f.handler(async () => {
    if (++requests === 1) return oldResponse.promise;
    return response([row(2)]);
  });
  const old = f.core.githubQuery(f.query);
  let replacement: ReturnType<typeof f.core.githubQuery> | undefined;
  try {
    await expect.poll(() => requests, { timeout: 5000 }).toBe(1);
    f.identity("new-user");
    f.beforeSession(async () => {
      replacementWaiting = true;
      await replacementSession.promise;
    });
    replacement = f.core.githubQuery(f.query);
    await expect.poll(() => replacementWaiting, { timeout: 5000 }).toBe(true);
    oldResponse.resolve({
      status: 200,
      headers: {},
      get body() {
        // Release the competing session after A consumes its response. Its identity commits
        // at the next await, while A does its real final filesystem/Git validation.
        replacementSession.resolve();
        return [row(1)];
      },
    });
    expect(await replacement).toMatchObject({
      status: "ready",
      identity: { login: "new-user" },
      items: [{ number: 2 }],
    });
    expect(await old).toMatchObject({ status: "error", code: "unauthenticated" });
    expect(await f.core.githubQuery(f.query)).toMatchObject({
      status: "ready",
      identity: { login: "new-user" },
      items: [{ number: 2 }],
    });
  } finally {
    replacementSession.resolve();
    oldResponse.resolve(response([]));
    await Promise.allSettled([old, ...(replacement ? [replacement] : [])]);
  }
}, 20000);

test("an obsolete GitHub network failure cannot return the old identity's cached rows", async () => {
  const f = await fixture();
  f.identity("old-user");
  const oldResponse = Promise.withResolvers<GitHubResponse>();
  let requests = 0;
  f.handler(async () => {
    requests++;
    if (requests === 2) return oldResponse.promise;
    return response([row(requests === 1 ? 1 : 2)]);
  });
  await f.core.githubQuery(f.query);
  const old = f.core.githubQuery({ ...f.query, refresh: true });
  try {
    await expect.poll(() => requests, { timeout: 5000 }).toBe(2);
    f.identity("new-user");
    expect(await f.core.githubQuery(f.query)).toMatchObject({
      status: "ready",
      identity: { login: "new-user" },
      items: [{ number: 2 }],
    });
    oldResponse.reject(new Error("old network failed"));
    const result = await old;
    expect(result.status === "error" && result.cached).toBeUndefined();
    expect(result).toMatchObject({ status: "error", code: "unauthenticated" });
  } finally {
    oldResponse.resolve(response([]));
    await Promise.allSettled([old]);
  }
}, 20000);

test("a project with no GitHub remote never sends a network request", async () => {
  const f = await fixture();
  await git(f.cwd, "remote", "remove", "origin");
  expect(await f.core.githubQuery(f.query)).toMatchObject({ status: "error", code: "not-github" });
  expect(f.paths).toHaveLength(0);
  await expect(f.core.githubQuery({ ...f.query, projectId: "missing" })).rejects.toMatchObject({
    code: "NotFound",
  });
});

test("an expired identity does not return cached private rows", async () => {
  const f = await fixture();
  f.identity("signed-in");
  f.handler(async () => response([row(4)]));
  await f.core.githubQuery(f.query);
  f.handler(async () => ({ status: 401, headers: {}, body: {} }));
  const result = await f.core.githubQuery({ ...f.query, refresh: true });
  expect(result).toMatchObject({ status: "error", code: "unauthenticated" });
  expect(result.status === "error" && result.cached).toBeUndefined();
});

test("remote selection retries keep the same operation and conflicting reuse of its ID is rejected", async () => {
  const f = await fixture();
  await git(f.cwd, "remote", "add", "upstream", "https://github.com/upstream/repo.git");
  await f.core.selectGitHubRemote(f.project.id, "upstream", "remote-once");
  await f.core.selectGitHubRemote(f.project.id, "origin", "remote-later");
  expect(await f.core.selectGitHubRemote(f.project.id, "upstream", "remote-once")).toMatchObject({
    status: "ready",
    github: { selection: { remote: "origin" } },
  });
  await expect(f.core.selectGitHubRemote(f.project.id, null, "remote-once")).rejects.toMatchObject({
    code: "InvalidInput",
  });
});

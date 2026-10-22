import { afterEach, expect, test } from "vite-plus/test";
import { BotClient } from "./client.ts";
import { MobileStore, draftKey } from "./store.ts";
import {
  events,
  json,
  library,
  memoryStorage,
  requestUrl,
  thread,
} from "./fixtures.test-support.ts";

const stores: MobileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});
const cases = (["create", "refresh"] as const).flatMap((stage) =>
  (["same-draft", "other-draft", "open", "current"] as const).map((action) => ({ stage, action })),
);

test.each(cases)(
  "project creation preserves newer navigation at $stage ($action)",
  async ({ stage, action }) => {
    const project = { id: "created-project", name: "Created", rootPath: "/created" };
    const workspace = {
      id: "created-workspace",
      projectId: project.id,
      cwd: "/created",
      kind: "project-root",
    };
    const initial = {
      ...library,
      projects: [...library.projects, { id: "other", name: "Other", rootPath: "/other" }],
      workspaces: [
        ...library.workspaces,
        { id: "other-workspace", projectId: "other", cwd: "/other", kind: "project-root" },
      ],
      threads: [thread.thread],
    };
    const release = Promise.withResolvers<void>();
    let created = false;
    let held = false;
    const hold = async () => {
      held = true;
      await release.promise;
    };
    const saved = memoryStorage();
    let id = 0;
    const store = new MobileStore(
      saved.storage,
      (connection) =>
        new BotClient(connection, async (url, init) => {
          const path = new URL(requestUrl(url)).pathname;
          if (path === "/v1/projects") {
            created = true;
            if (stage === "create") await hold();
            return json(project, 201);
          }
          if (path === "/v1/library") {
            if (created && stage === "refresh") await hold();
            return json({
              ...initial,
              projects: created ? [...initial.projects, project] : initial.projects,
              workspaces: created ? [...initial.workspaces, workspace] : initial.workspaces,
            });
          }
          if (path.endsWith("/events")) return events(init?.signal);
          if (path === "/v1/threads/thread") return json(thread);
          throw new Error("Unexpected request: " + path);
        }),
      () => "request-" + ++id,
    );
    stores.push(store);
    await store.connect({ url: "https://bot", token: "secret" });
    const creating = store.createProject(project.name);
    try {
      await expect.poll(() => held, { timeout: 1000 }).toBe(true);
      if (action === "same-draft") store.newThread("workspace");
      if (action === "other-draft") store.newThread("other-workspace");
      if (action === "open") await store.open(thread.id);
      if (action !== "current") store.setDraft("Keep my current draft");
      release.resolve();
      await creating;
      const state = store.getSnapshot();
      expect({ workspaceId: state.workspaceId, threadId: state.threadId }).toEqual({
        workspaceId:
          action === "current"
            ? workspace.id
            : action === "other-draft"
              ? "other-workspace"
              : "workspace",
        threadId: action === "open" ? thread.id : undefined,
      });
      if (action !== "current") expect(state.drafts[draftKey(state)]).toBe("Keep my current draft");
      expect(state.library?.projects.some((value) => value.id === project.id)).toBe(true);
      expect(state.library?.workspaces.some((value) => value.id === workspace.id)).toBe(true);
    } finally {
      release.resolve();
      await creating.catch(() => {});
    }
  },
);

import { expect, test } from "vite-plus/test";
import { defaultModel, projectRootWorkspace } from "./selectors.ts";
import type { AgentModel } from "../../../src/agent/protocol.ts";
import type { WorkspaceMetadata } from "../../../src/shared/workspaces.ts";

const models: AgentModel[] = ["first", "chosen"].map((id) => ({
  id,
  provider: "test",
  name: id,
  contextWindow: 1000,
  thinkingLevels: ["off"],
}));

test("model fallback uses the configured provider/model, then the available catalog", () => {
  expect(
    defaultModel({
      models,
      settings: {
        defaultProvider: "test",
        defaultModel: "chosen",
        defaultThinkingLevel: "off",
      },
    })?.id,
  ).toBe("chosen");
  expect(
    defaultModel({
      models,
      settings: {
        defaultProvider: "unavailable",
        defaultModel: "chosen",
        defaultThinkingLevel: "off",
      },
    })?.id,
  ).toBe("first");
  expect(defaultModel({ models: [], settings: { defaultThinkingLevel: "off" } })).toBeUndefined();
});

test("project-root selection never chooses a worktree even when it appears first", () => {
  const workspaces: WorkspaceMetadata[] = [
    { id: "worktree", projectId: "project", kind: "worktree", cwd: "/worktree", createdAt: 1 },
    { id: "root", projectId: "project", kind: "project-root", cwd: "/project", createdAt: 1 },
  ];
  expect(projectRootWorkspace(workspaces, "project")?.id).toBe("root");
  expect(projectRootWorkspace(workspaces.slice(0, 1), "project")).toBeUndefined();
  expect(projectRootWorkspace(workspaces, null)).toBeUndefined();
});

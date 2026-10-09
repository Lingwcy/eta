import { expect, test } from "vite-plus/test";
import type { ThreadMetadata } from "@eta/core/shared/threads";
import {
  canGenerateTitle,
  applyInputTitle,
  applyGeneratedTitle,
  applyManualTitle,
} from "@eta/core/service/titles/policy";

function thread(): ThreadMetadata {
  return {
    id: "thread",
    workspaceId: "workspace",
    title: "新会话",
    titleSource: "temporary",
    createdAt: 1,
    sessionRef: {
      backendId: "eta",
      metadata: {
        id: "session",
        cwd: "/project",
        path: "/session",
        createdAt: 1,
        modifiedAt: 1,
        storageVersion: 1,
      },
    },
  };
}

test("first input gives a temporary title, later inputs do not rename it, generation finishes it", () => {
  const initial = thread();
  const first = applyInputTitle(initial, "Fix the settings refresh", canGenerateTitle(initial));
  const next = applyInputTitle(first, "Do something else", canGenerateTitle(first));
  expect(next.title).toBe("Fix the settings refresh");
  const generated = applyGeneratedTitle(next, "Settings refresh");
  expect(generated).toMatchObject({ title: "Settings refresh", titleSource: "generated" });
  expect(canGenerateTitle(generated)).toBe(false);
  expect(applyGeneratedTitle(generated, "Late result").title).toBe("Settings refresh");
});

test("manual rename wins over pending input and generated-title delivery", () => {
  const initial = thread();
  const automatic = canGenerateTitle(initial);
  const renamed = applyManualTitle(initial, "  My title  ");
  expect(applyInputTitle(renamed, "Pending input", automatic)).toMatchObject({
    title: "My title",
    titleSource: "manual",
  });
  expect(applyGeneratedTitle(renamed, "Late generated title")).toBe(renamed);
  expect(canGenerateTitle(renamed)).toBe(false);
});

test("legacy unnamed threads can generate a title but named histories are preserved", () => {
  const { titleSource: _source, ...legacy } = thread();
  expect(canGenerateTitle(legacy)).toBe(true);
  const temporary = applyInputTitle(legacy, "x".repeat(100), true);
  expect(temporary.title.length).toBe(80);
  expect(temporary.titleSource).toBe("temporary");
  const named = { ...legacy, title: "Saved history" };
  expect(canGenerateTitle(named)).toBe(false);
  expect(applyInputTitle(named, "New input", false)).toBe(named);
  expect(applyGeneratedTitle(named, "Generated title")).toBe(named);
});

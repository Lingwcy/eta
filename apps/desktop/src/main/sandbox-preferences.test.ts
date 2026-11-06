import { expect, test } from "vite-plus/test";
import { DesktopSettingsService } from "./service/settings/index.ts";
import { ThreadService } from "@eta/core/service/threads/index";
import { setup } from "./tests/runtime-fixture.ts";

test("new chats follow the latest preference without changing existing chats, including after reopen", async () => {
  const f = await setup();
  expect(f.created.snapshot.sandbox?.mode).toBe("danger-full-access");
  await f.runtime.runPromise(f.threads.configureSandbox(f.created.id, "workspace-write"));
  for (const mode of ["read-only", "danger-full-access", "workspace-write"] as const) {
    await f.runtime.runPromise(f.settings.update({ defaultSandboxMode: mode }));
    const created = await f.runtime.runPromise(f.threads.create(f.workspace.id));
    expect(created.snapshot.sandbox?.mode).toBe(mode);
    expect((await f.runtime.runPromise(f.threads.open(f.created.id))).snapshot.sandbox?.mode).toBe(
      "workspace-write",
    );
  }
  await f.runtime.dispose();
  const restored = f.reopen();
  const settings = await restored.runPromise(DesktopSettingsService);
  const threads = await restored.runPromise(ThreadService);
  expect((await restored.runPromise(settings.read)).defaultSandboxMode).toBe("workspace-write");
  expect((await restored.runPromise(threads.create(f.workspace.id))).snapshot.sandbox?.mode).toBe(
    "workspace-write",
  );
  expect((await restored.runPromise(threads.open(f.created.id))).snapshot.sandbox?.mode).toBe(
    "workspace-write",
  );
});

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { AppPathsService } from "../src/platform/app-paths.ts";
import { CredentialService } from "../src/service/credentials/index.ts";
import { createCore } from "../src/client.ts";

test("an existing thread uses the replacement account for its next model request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-account-switch-"));
  const runtime = ManagedRuntime.make(
    CredentialService.layer.pipe(Layer.provide(AppPathsService.layer(join(directory, "auth")))),
  );
  let core: Awaited<ReturnType<typeof createCore>> | undefined;
  try {
    const credentials = await runtime.runPromise(CredentialService);
    const modelProvider = fauxProvider({ provider: "account-test", models: [{ id: "one" }] });
    const titles = fauxProvider({ provider: "account-test", models: [{ id: "one" }] });
    const auth = {
      oauth: {
        name: "Test account",
        login: async () => {
          throw new Error("not used");
        },
        refresh: async () => {
          throw new Error("unexpected refresh");
        },
        toAuth: async (value: { access: string }) => ({ apiKey: value.access }),
      },
    };
    const requests: string[] = [];
    const models = createModels({ credentials: credentials.store });
    models.setProvider({
      ...modelProvider.provider,
      auth,
      streamSimple: (model, context, options) => {
        if (options?.sessionId?.endsWith(":title"))
          return titles.provider.streamSimple(model, context, options);
        requests.push(options?.apiKey ?? "missing");
        return modelProvider.provider.streamSimple(model, context, options);
      },
    });
    const account = (access: string) => ({
      type: "oauth" as const,
      access,
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
    });
    await credentials.loginStore.modify("account-test", async () => account("first"));
    const cwd = join(directory, "workspace");
    await mkdir(cwd);
    core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      settings: {
        read: Effect.succeed({
          agentMode: "standard",
          defaultThinkingLevel: "off",
          approvalReviewer: { mode: "user" },
        }),
        subscribe: () => () => {},
      },
      environment: { userAgent: "eta-test", shutdown: "preserve" },
    });
    const project = await core.registerProject(cwd);
    const workspace = (await core.workspaces(project.id))[0]!;
    const thread = await core.createThread(workspace.id, "account-switch");
    modelProvider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit reached" }),
      fauxAssistantMessage("second reply"),
    ]);
    const first = await core.submit(thread.id, "first", "first-input");
    await expect
      .poll(async () => (await core!.operation(thread.id, first.operationId)).status, {
        timeout: 10_000,
      })
      .toBe("failed");
    await credentials.store.delete("account-test");
    expect((await core.openThread(thread.id)).snapshot.blockedReason).toContain("认证不可用");
    await credentials.loginStore.modify("account-test", async () => account("second"));
    expect((await core.openThread(thread.id)).snapshot.blockedReason).toBeUndefined();
    const second = await core.submit(thread.id, "second", "second-input");
    await expect
      .poll(async () => (await core!.operation(thread.id, second.operationId)).status, {
        timeout: 10_000,
      })
      .toBe("completed");
    expect(requests).toEqual(["first", "second"]);
  } finally {
    await core?.close();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { desktopServices } from "../layer.ts";
import { SkillsService } from "../skills/index.ts";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ThreadService } from "@eta/core/service/threads/index";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { CredentialService } from "@eta/core/service/credentials/index";
import { ModelCatalogService } from "./index.ts";
import { DesktopSettingsService } from "../settings/index.ts";
import { DesktopAuthentication } from "../../authentication/index.ts";

// Keep unrelated built-in providers offline, but exercise the real Magpie provider and catalog.
vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { createModels, fauxProvider } = await import("@earendil-works/pi-ai");
  return {
    builtinModels: () => {
      const models = createModels();
      models.setProvider(
        fauxProvider({ provider: "direct", models: [{ id: "existing" }] }).provider,
      );
      return models;
    },
  };
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "eta-magpie-startup-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
  const config = join(root, ".config", "eta", "magpie.json");
  await mkdir(join(root, ".config", "eta"), { recursive: true });
  let ids = ["group/smart-split-2", "vendor/model"];
  let toolCycle = false;
  const toolPath = join(root, "fixture.txt");
  await writeFile(toolPath, "MAGPIE_TOOL_READ_PROOF");
  const toolResults: string[] = [];
  const requests: { path?: string; key?: string }[] = [];
  const generations: { model: string; session?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, key: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        generations.push({
          model: body.model,
          session: request.headers["x-magpie-session"] as string | undefined,
        });
        response.setHeader("Content-Type", "text/event-stream");
        const results = body.messages.filter(
          (message: { role: string }) => message.role === "tool",
        );
        for (const result of results) toolResults.push(JSON.stringify(result));
        const needsRead =
          toolCycle &&
          results.length === 0 &&
          body.tools?.some(
            (tool: { function?: { name?: string } }) => tool.function?.name === "read",
          );
        const delta = needsRead
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: toolPath }) },
                },
              ],
            }
          : { role: "assistant", content: "Magpie runtime reply" };
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: needsRead ? "tool_calls" : "stop" }],
        };
        response.end("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n");
      });
    } else if (request.url === "/api/hello") {
      response.end(JSON.stringify({ name: "magpie", version: "fixture" }));
    } else if (
      request.url === "/v1/models" &&
      request.headers.authorization === "Bearer magpie-eta"
    ) {
      response.end(
        JSON.stringify({
          data: ids.map((id) => ({
            id,
            display_name: id,
            context_window: 32768,
            max_output_tokens: 4096,
            reasoning: false,
            modalities: { input: ["text"] },
            tool_call: true,
          })),
        }),
      );
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const configure = () =>
    writeFile(config, JSON.stringify({ version: 1, baseUrl, apiKey: "magpie-eta" }));
  const open = async () => {
    const runtime = ManagedRuntime.make(
      desktopServices(join(root, "data"), undefined, undefined, SkillsService.layerWith(root)),
    );
    cleanup.push(() => runtime.dispose());
    const catalog = await runtime.runPromise(ModelCatalogService);
    const settings = await runtime.runPromise(DesktopSettingsService);
    const credentials = await runtime.runPromise(CredentialService);
    return {
      runtime,
      catalog,
      settings,
      credentials,
      list: () => runtime.runPromise(catalog.list),
    };
  };
  return {
    root,
    config,
    configure,
    open,
    requests,
    generations,
    toolResults,
    enableToolCycle: () => {
      toolCycle = true;
    },
    setIds: (next: string[]) => {
      ids = next;
    },
  };
}

test("Magpie opt-in appears after restart without changing direct credentials or defaults", async () => {
  const fixture = await setup();
  const before = await fixture.open();
  expect((await before.list()).map((model) => model.provider)).toEqual(["direct"]);
  await before.runtime.runPromise(before.credentials.setApiKey("direct", "keep-this-key"));
  await before.runtime.runPromise(
    before.settings.update({ defaultProvider: "direct", defaultModel: "existing" }),
  );
  await before.runtime.dispose();

  await fixture.configure();
  const configuredFile = await readFile(fixture.config, "utf8");
  const after = await fixture.open();
  expect(
    (await after.list()).filter((model) => model.provider === "magpie").map((model) => model.id),
  ).toEqual(["group/smart-split-2", "vendor/model"]);
  expect(await after.runtime.runPromise(after.settings.read)).toMatchObject({
    defaultProvider: "direct",
    defaultModel: "existing",
  });
  expect(await after.credentials.store.read("direct")).toEqual({
    type: "api_key",
    key: "keep-this-key",
  });
  expect(await after.credentials.store.read("magpie")).toBeUndefined();
  const auth = new DesktopAuthentication(
    after.catalog.models,
    after.credentials.store,
    async () => {},
    "fixture",
  );
  expect(auth.providers().some((provider) => provider.id === "magpie")).toBe(false);
  expect(fixture.requests).toContainEqual({ path: "/v1/models", key: "Bearer magpie-eta" });
  expect(await readFile(fixture.config, "utf8")).toBe(configuredFile);
  await after.runtime.dispose();

  fixture.setIds(["group/updated"]);
  const updated = await fixture.open();
  expect(
    (await updated.list()).filter((model) => model.provider === "magpie").map((model) => model.id),
  ).toEqual(["group/updated"]);
  await updated.runtime.dispose();
  await rm(fixture.config);
  const disconnected = await fixture.open();
  expect((await disconnected.list()).map((model) => model.provider)).toEqual(["direct"]);
  expect(await disconnected.credentials.store.read("direct")).toEqual({
    type: "api_key",
    key: "keep-this-key",
  });
});

test("invalid integration configuration does not prevent startup or erase direct models", async () => {
  const fixture = await setup();
  await writeFile(fixture.config, '{"version":1,"apiKey":"secret-do-not-log","baseUrl":"invalid"}');
  const application = await fixture.open();
  expect((await application.list()).map((model) => model.provider)).toEqual(["direct"]);
  expect(fixture.requests).toHaveLength(0);
  expect(await readFile(fixture.config, "utf8")).toContain("secret-do-not-log");
});

test("a Magpie route completes a real thread tool loop and retains its session after restart", async () => {
  const fixture = await setup();
  fixture.enableToolCycle();
  await fixture.configure();
  const application = await fixture.open();
  await application.list();
  await application.runtime.runPromise(application.settings.update({ agentMode: "standard" }));
  const projects = await application.runtime.runPromise(ProjectService);
  const project = await application.runtime.runPromise(
    projects.register({ rootPath: fixture.root }),
  );
  const workspaces = await application.runtime.runPromise(WorkspaceService);
  const workspace = (await application.runtime.runPromise(workspaces.list(project.id)))[0]!;
  const threads = await application.runtime.runPromise(ThreadService);
  const created = await application.runtime.runPromise(threads.create(workspace.id));
  await application.runtime.runPromise(
    threads.configure(created.id, "magpie", "group/smart-split-2", "off"),
  );
  const first = await application.runtime.runPromise(
    threads.submit(created.id, "Use the configured route"),
  );
  await expect
    .poll(
      async () =>
        (await application.runtime.runPromise(threads.operation(created.id, first.operationId)))
          .status,
      { timeout: 15000 },
    )
    .toBe("completed");
  expect(JSON.stringify(await application.runtime.runPromise(threads.open(created.id)))).toContain(
    "Magpie runtime reply",
  );
  expect(fixture.toolResults.some((result) => result.includes("MAGPIE_TOOL_READ_PROOF"))).toBe(
    true,
  );
  const session = fixture.generations.find((call) => !call.session?.endsWith(":title"))?.session;
  expect(session).toEqual(expect.any(String));
  expect(fixture.generations.some((call) => call.model === "group/smart-split-2")).toBe(true);
  await application.runtime.dispose();

  // Background/resumed work must not depend on opening the model picker first.
  const restarted = await fixture.open();
  const restoredThreads = await restarted.runtime.runPromise(ThreadService);
  const second = await restarted.runtime.runPromise(
    restoredThreads.submit(created.id, "Continue after restart"),
  );
  await expect
    .poll(
      async () =>
        (
          await restarted.runtime.runPromise(
            restoredThreads.operation(created.id, second.operationId),
          )
        ).status,
      { timeout: 15000 },
    )
    .toBe("completed");
  const turns = fixture.generations.filter((call) => !call.session?.endsWith(":title"));
  expect(turns.length).toBeGreaterThanOrEqual(2);
  expect(
    turns.every((call) => call.model === "group/smart-split-2" && call.session === session),
  ).toBe(true);
});

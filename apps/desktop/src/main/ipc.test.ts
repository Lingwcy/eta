import { expect, test } from "vite-plus/test";
import { commandReply, dispatchCommand } from "./ipc.ts";
import type { DesktopApplication } from "./bootstrap.ts";
import { CoreError } from "@eta/core/service/errors";

test.each([
  { type: "skills", cwd: 123 },
  { type: "open-skills-directory", path: "" },
  { type: "open-skills-directory", path: "/skills", cwd: 123 },
  { type: "open-skills-directory", path: "/skills", create: true },
  { type: "unload-skill", id: "thread", name: "" },
  { type: "settings", patch: { skillDirectories: [""] } },
  { type: "settings", patch: { disabledSkills: "review" } },
  { type: "settings", patch: { skillsEnabled: "yes" } },
  { type: "settings", patch: { agentThinkingVariant: "unknown" } },
  { type: "settings", patch: { agentThinkingVariant: null } },
  { type: "move-thread", id: "thread", projectId: "" },
  { type: "move-thread", id: "thread", projectId: { path: "/project" } },
  { type: "delete-thread", id: "" },
  { type: "create", workspaceId: "", requestId: "request" },
  {
    type: "create",
    workspaceId: "workspace",
    requestId: "request",
    configuration: {
      provider: "test",
      modelId: "model",
      thinkingLevel: "off",
      sandboxMode: "unknown",
    },
  },
  { type: "register-project", rootPath: "", name: "Project" },
  { type: "register-project", rootPath: "/project", name: 42 },
  { type: "archive", id: "thread", archived: "yes" },
  { type: "credential", provider: 1, key: "do-not-echo-this-secret" },
  { type: "settings", patch: { defaultThinkingLevel: "not-a-level" } },
  { type: "settings", patch: { credentialsPath: "/arbitrary-path" } },
  { type: "login-start", provider: "openai", method: "password" },
  { type: "login-answer", id: "id", promptId: "prompt", value: { key: "do-not-echo-this-secret" } },
  { type: "logout", provider: "openai", method: "wrong" },
  { type: "login-cancel", id: "" },
  { type: "settings", patch: { disabledTools: ["unknown-tool"] } },
  { type: "settings", patch: { disabledTools: "bash" } },
  { type: "settings", patch: { titleModel: { provider: "test" } } },
  { type: "settings", patch: { titleModel: { provider: "", modelId: "small" } } },
  { type: "settings", patch: { titleModel: "small" } },
  { type: "submit", id: "thread", prompt: "Hello", requestId: "id", images: null },
  { type: "submit", id: "thread", prompt: "Hello", requestId: "id", images: "not-an-array" },
  { type: "prepare-image", source: { path: "shot.png" }, provider: 123 },
  { type: "not-a-command" },
  { type: "storage", path: "/arbitrary-path" },
  { type: "reveal-storage", target: { kind: "configuration", id: "" } },
  { type: "reveal-storage", target: { kind: "sessions", path: "/arbitrary-path" } },
  { type: "reveal-storage", target: { kind: "unknown" } },
])(
  "untrusted command payloads fail before reaching application services: $type",
  async (command) => {
    const reply = await commandReply(() => dispatchCommand({} as DesktopApplication, command));
    expect(reply).toEqual({
      ok: false,
      error: { code: "InvalidInput", message: "请求参数无效", retryable: false },
    });
    expect(JSON.stringify(reply)).not.toContain("do-not-echo-this-secret");
  },
);
test("thread creation accepts the sandbox configuration sent by the composer", async () => {
  const configuration = {
    provider: "test",
    modelId: "model",
    thinkingLevel: "off",
    sandboxMode: "read-only",
  };
  const application = {
    createThread: async (...args: Parameters<DesktopApplication["createThread"]>) => {
      expect(args[2]).toEqual(configuration);
      throw new CoreError({ code: "ModelUnavailable", message: "模型尚未配置" });
    },
  } satisfies Pick<DesktopApplication, "createThread">;
  const reply = await commandReply(() =>
    dispatchCommand(application as unknown as DesktopApplication, {
      type: "create",
      workspaceId: "workspace",
      requestId: "request",
      configuration,
    }),
  );
  expect(reply).toEqual({
    ok: false,
    error: { code: "ModelUnavailable", message: "模型尚未配置", retryable: true },
  });
});
test.each(["Busy", "SandboxUnavailable"] as const)(
  "%s and retryability survive Electron's JSON boundary",
  async (code) => {
    const reply = await commandReply(async () => {
      throw new CoreError({ code, message: "当前执行环境不可用" });
    });
    expect(reply).toEqual({
      ok: false,
      error: { code, message: "当前执行环境不可用", retryable: true },
    });
  },
);

test("image preparation accepts Electron's undefined optional fields and returns a real image block", async () => {
  const { processImage } = await import("@eta/core/node/images");
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
  const application = {
    prepareImage: async (source: { data: string; name: string }) =>
      processImage(Buffer.from(source.data, "base64"), source.name),
  } as DesktopApplication;
  const image = await dispatchCommand(
    application,
    structuredClone({
      type: "prepare-image",
      source: { data, name: "clipboard.png" },
      cwd: undefined,
      provider: undefined,
      modelId: undefined,
    }),
  );
  expect(image).toMatchObject({ type: "image", mimeType: "image/png", data });
});

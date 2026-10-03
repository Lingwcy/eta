import { expect, test } from "vite-plus/test";
import { commandReply, dispatchCommand } from "./ipc.ts";
import type { DesktopApplication } from "./bootstrap.ts";
import { DesktopServiceError } from "./service/errors.ts";

test.each([
  { type: "create", workspaceId: "", requestId: "request" },
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
  { type: "not-a-command" },
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
test("domain error codes and retryability survive Electron's JSON boundary", async () => {
  const reply = await commandReply(async () => {
    throw new DesktopServiceError({ code: "Busy", message: "工作区正在运行" });
  });
  expect(reply).toEqual({
    ok: false,
    error: { code: "Busy", message: "工作区正在运行", retryable: true },
  });
});

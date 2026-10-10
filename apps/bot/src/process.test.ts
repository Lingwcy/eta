import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

const Event = Schema.Struct({ event: Schema.String, port: Schema.optionalKey(Schema.Number) });
const WorkspaceList = Schema.Array(Schema.Struct({ id: Schema.String }));
const Thread = Schema.Struct({ id: Schema.String });
const Operation = Schema.Struct({
  operationId: Schema.String,
  status: Schema.optionalKey(Schema.String),
});
const History = Schema.Struct({
  snapshot: Schema.Struct({
    transcript: Schema.Array(Schema.Struct({ message: Schema.Struct({ role: Schema.String }) })),
  }),
});

test("SIGKILL releases the writer lock and a fresh Bot process resumes persisted HTTP work", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-process-"));
  let child: ChildProcess | undefined;
  const children: ChildProcess[] = [];
  let stderr = "";
  const config = join(root, "config.json");
  const headers = {
    authorization: "Bearer process-test-token",
    "content-type": "application/json",
  };
  const start = async (mode: string) => {
    const listening = Promise.withResolvers<number>();
    const waiting = Promise.withResolvers<void>();
    child = fork(fileURLToPath(new URL("./fixtures/process.ts", import.meta.url)), [config, mode], {
      execArgv: [
        "--experimental-transform-types",
        "--import",
        fileURLToPath(new URL("./source-loader.ts", import.meta.url)),
      ],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("message", (value) => {
      const event = Schema.decodeUnknownSync(Event)(value);
      if (event.event === "listening") listening.resolve(event.port!);
      if (event.event === "waiting") waiting.resolve();
    });
    child.once("exit", (code) => listening.reject(new Error(`Bot exited (${code}): ${stderr}`)));
    return { base: `http://127.0.0.1:${await listening.promise}`, waiting: waiting.promise };
  };
  try {
    await mkdir(join(root, "workspaces", "workspace"), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        dataRoot: "data",
        adminToken: "process-test-token",
        workspaceRoot: "workspaces",
        projects: [{ key: "test", rootPath: "workspaces/workspace" }],
        runtime: { defaultThinkingLevel: "off" },
      }),
    );
    const first = await start("hold");
    const workspaces = Schema.decodeUnknownSync(WorkspaceList)(
      await (await fetch(`${first.base}/v1/workspaces`, { headers })).json(),
    );
    const thread = Schema.decodeUnknownSync(Thread)(
      await (
        await fetch(`${first.base}/v1/threads`, {
          method: "POST",
          headers,
          body: JSON.stringify({ workspaceId: workspaces[0]!.id, requestId: "create" }),
        })
      ).json(),
    );
    const response = await fetch(`${first.base}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Write a file and finish", requestId: "input" }),
    });
    expect(response.status).toBe(202);
    const operation = Schema.decodeUnknownSync(Operation)(await response.json());
    await first.waiting;
    const exited = once(child!, "exit");
    child!.kill("SIGKILL");
    await exited;
    expect(await readFile(join(root, "workspaces/workspace/process-result.txt"), "utf8")).toBe(
      "Written before SIGKILL",
    );
    const restored = await start("finish");
    await expect
      .poll(
        async () =>
          Schema.decodeUnknownSync(Operation)(
            await (
              await fetch(
                `${restored.base}/v1/threads/${thread.id}/operations/${operation.operationId}`,
                { headers },
              )
            ).json(),
          ).status,
      )
      .toBe("completed");
    const history = Schema.decodeUnknownSync(History)(
      await (await fetch(`${restored.base}/v1/threads/${thread.id}`, { headers })).json(),
    );
    expect(
      history.snapshot.transcript.filter(({ message }) => message.role === "user"),
    ).toHaveLength(1);
  } finally {
    for (const process of children) {
      if (process.exitCode !== null || process.signalCode !== null) continue;
      const exited = once(process, "exit");
      process.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

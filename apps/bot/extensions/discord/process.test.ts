import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

const Event = Schema.Struct({
  event: Schema.String,
  port: Schema.optionalKey(Schema.Number),
  phase: Schema.optionalKey(Schema.String),
});
const Status = Schema.Struct({
  extensions: Schema.Struct({
    discord: Schema.Struct({
      inputs: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          state: Schema.String,
          operationId: Schema.NullOr(Schema.String),
        }),
      ),
      issues: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          state: Schema.String,
          etaThreadId: Schema.NullOr(Schema.String),
        }),
      ),
      deliveries: Schema.Array(Schema.Struct({ state: Schema.String })),
    }),
  }),
});
const History = Schema.Struct({
  snapshot: Schema.Struct({
    transcript: Schema.Array(Schema.Struct({ message: Schema.Struct({ role: Schema.String }) })),
  }),
});
const Operation = Schema.Struct({ status: Schema.String });
const Count = Schema.Struct({ count: Schema.Number });

test.each(["create", "thread", "execute", "result", "send", "stop"])(
  "SIGKILL during %s reconciles Discord and Core durable records",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "eta-discord-process-"));
    const children: ChildProcess[] = [];
    const config = join(root, "config.json");
    const headers = { authorization: "Bearer crash-test" };
    const start = async (mode: string) => {
      let stderr = "";
      const listening = Promise.withResolvers<number>();
      const halted = Promise.withResolvers<void>();
      const readyStop = Promise.withResolvers<void>();
      const child = fork(
        fileURLToPath(new URL("./fixtures/process.ts", import.meta.url)),
        [config, mode],
        {
          execArgv: [
            "--experimental-transform-types",
            "--import",
            fileURLToPath(new URL("../../src/source-loader.ts", import.meta.url)),
          ],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("message", (value) => {
        const event = Schema.decodeUnknownSync(Event)(value);
        if (event.event === "listening") listening.resolve(event.port!);
        if (event.event === "halted") halted.resolve();
        if (event.event === "ready-stop") readyStop.resolve();
      });
      child.once("exit", (code) => listening.reject(new Error(`Bot exited (${code}): ${stderr}`)));
      return {
        child,
        base: `http://127.0.0.1:${await listening.promise}`,
        halted: halted.promise,
        readyStop: readyStop.promise,
      };
    };
    try {
      await mkdir(join(root, "workspace"));
      await writeFile(
        config,
        JSON.stringify({
          dataRoot: "data",
          adminToken: "crash-test",
          shutdownGraceMs: 0,
          projects: [{ key: "test", rootPath: "workspace" }],
          runtime: { defaultThinkingLevel: "off" },
          discord: {
            tokenEnv: "UNUSED_MOCK_TOKEN",
            channels: [{ guildId: "1", channelId: "10", projectKey: "test", startAfter: "1001" }],
          },
        }),
      );
      const first = await start(phase);
      first.child.send("work");
      let closing: Promise<Response> | undefined;
      if (phase === "stop") {
        await first.readyStop;
        closing = fetch(`${first.base}/v1/extensions/discord/issues/1002/close`, {
          method: "POST",
          headers,
        }).catch(() => new Response(null, { status: 503 }));
      }
      await first.halted;
      const exited = once(first.child, "exit");
      first.child.kill("SIGKILL");
      await exited;
      await closing;
      const restored = await start("finish");
      const status = async () =>
        Schema.decodeUnknownSync(Status)(
          await (await fetch(`${restored.base}/v1/status`, { headers })).json(),
        ).extensions.discord;
      await expect
        .poll(async () => (await status()).inputs[0]?.state, { timeout: 8000 })
        .toBe(phase === "stop" ? "cancelled" : "done");
      const current = await status();
      expect(current.issues).toHaveLength(1);
      expect(current.inputs).toHaveLength(1);
      const issue = current.issues[0]!;
      const history = Schema.decodeUnknownSync(History)(
        await (await fetch(`${restored.base}/v1/threads/${issue.etaThreadId}`, { headers })).json(),
      );
      expect(
        history.snapshot.transcript.filter(({ message }) => message.role === "user"),
      ).toHaveLength(1);
      const operation = Schema.decodeUnknownSync(Operation)(
        await (
          await fetch(
            `${restored.base}/v1/threads/${issue.etaThreadId}/operations/${current.inputs[0]!.operationId}`,
            { headers },
          )
        ).json(),
      );
      expect(operation.status).toBe(phase === "stop" ? "aborted" : "completed");
      expect(await readFile(join(root, "workspace/crash-proof.txt"), "utf8")).toBe(
        "Investigated before reply",
      );
      const remote = new DatabaseSync(join(root, "remote.sqlite"));
      try {
        expect(
          Schema.decodeUnknownSync(Count)(
            remote.prepare("SELECT COUNT(*) AS count FROM threads").get(),
          ).count,
        ).toBe(1);
        expect(
          Schema.decodeUnknownSync(Count)(
            remote.prepare("SELECT COUNT(*) AS count FROM messages WHERE id='10000'").get(),
          ).count,
        ).toBe(phase === "stop" ? 0 : 1);
      } finally {
        remote.close();
      }
      expect(current.deliveries.every((record) => record.state === "sent")).toBe(true);
      if (phase === "stop") expect(issue.state).toBe("closed");
    } finally {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

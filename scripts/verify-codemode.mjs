import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Exercise the distributed worker and WASM outside the repository, including its tool bridge. */
export async function verifyCodemode(Sandbox, directory, workspace, extension) {
  const sandbox = new Sandbox({
    workerUrl: pathToFileURL(join(directory, `codemode-worker.${extension}`)),
    wasmPath: join(directory, "quickjs.wasm"),
  });
  try {
    let run;
    let sequence = 0;
    run = sandbox.start('text(await tools.write({content:"packaged Code mode"}));', {
      startedAt: Date.now(),
      seed: 1,
      timeoutMs: 10000,
      tools: [{ name: "write" }],
      onCall: (call) => {
        void writeFile(join(workspace, "codemode-proof.txt"), call.args.content).then(
          () => run.deliver(++sequence, Date.now(), call.id, { ok: true, value: "written" }),
          (error) =>
            run.deliver(++sequence, Date.now(), call.id, { ok: false, message: error.message }),
        );
      },
    });
    const result = await run.result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.output[0].text, "written");
    assert.equal(
      await readFile(join(workspace, "codemode-proof.txt"), "utf8"),
      "packaged Code mode",
    );
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    const pending = sandbox.start("while(true) {}", {
      startedAt: Date.now(),
      seed: 2,
      timeoutMs: 10000,
      onCall() {},
      onStarted: ready,
    });
    await Promise.race([
      started,
      pending.result.then((value) => {
        throw new Error(`Worker ended before startup: ${JSON.stringify(value)}`);
      }),
    ]);
    await sandbox.close();
    assert.equal((await pending.result).error.kind, "aborted");
  } finally {
    await sandbox.close();
  }
}

import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vite-plus/test";
import { createAccessibilityBridge } from "../../src/mac/accessibility.ts";

const directories: string[] = [];
const bridges: ReturnType<typeof createAccessibilityBridge>[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.reset()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(
  source: string,
  onPointer?: Parameters<typeof createAccessibilityBridge>[1],
) {
  const directory = await mkdtemp(join(tmpdir(), "eta-ax-bridge-"));
  directories.push(directory);
  const binary = join(directory, "helper");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);${source}});`,
  );
  await chmod(binary, 0o755);
  const bridge = createAccessibilityBridge(binary, onPointer);
  bridges.push(bridge);
  return bridge;
}

test.skipIf(process.platform === "win32")(
  "validates native observations and reports exact native non-execution failures",
  async () => {
    const bridge = await fixture(
      `console.log(JSON.stringify(r.operation==='observe'?{ok:true,result:{id:'one',app:r.app,windowTitle:'test',text:'[1] AXTextField'}}:{ok:false,message:'stale element',applied:'no'}));`,
    );
    const state = await bridge.observe({ app: "TextEdit" }, AbortSignal.timeout(5000));
    expect(state.text).toBe("[1] AXTextField");
    await expect(
      bridge.execute(
        state,
        "set_value",
        { elementIndex: 1, text: "中文" },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ applied: "no", message: "stale element" });
  },
);

test.skipIf(process.platform === "win32")(
  "rejects malformed native state without publishing an element map",
  async () => {
    const bridge = await fixture(
      `console.log(JSON.stringify({ok:true,result:{id:'one',text:42}}));`,
    );
    await expect(bridge.observe({ app: "test" }, AbortSignal.timeout(5000))).rejects.toBeDefined();
  },
);

test.skipIf(process.platform === "win32")(
  "user takeover crosses native JSONL without poisoning cleanup or changing execution certainty",
  async () => {
    const bridge = await fixture(
      `console.log(JSON.stringify(r.app==='taken'?{ok:false,message:'user takeover',applied:'unknown',reason:'user_interrupted'}:{ok:true,result:{id:'one',app:r.app,windowTitle:'test',text:'ready'}}));`,
    );
    await expect(bridge.observe({ app: "taken" }, AbortSignal.timeout(5000))).rejects.toMatchObject(
      {
        code: "user_interrupted",
        applied: "unknown",
      },
    );
    expect(() => bridge.assertHealthy()).not.toThrow();
    await bridge.reset();
    expect((await bridge.observe({ app: "new" }, AbortSignal.timeout(5000))).app).toBe("new");
  },
);

test.skipIf(process.platform === "win32")(
  "cleanup ownership checks do not start a helper and inspect live takeover before reset",
  async () => {
    const bridge = await fixture(
      `console.log(JSON.stringify(r.operation==='check_ownership'?{ok:false,message:'takeover',applied:'no',reason:'user_interrupted'}:{ok:true,result:{id:String(process.pid),app:r.app,windowTitle:'test',text:'ready'}}));`,
    );
    await bridge.checkOwnership(AbortSignal.timeout(5000), true);
    const state = await bridge.observe({ app: "TextEdit" }, AbortSignal.timeout(5000));
    await expect(bridge.checkOwnership(AbortSignal.timeout(5000), true)).rejects.toMatchObject({
      code: "user_interrupted",
    });
    await bridge.reset();
    expect(() => process.kill(Number(state.id), 0)).toThrow();
    await bridge.checkOwnership(AbortSignal.timeout(5000), true);
  },
);

test.skipIf(process.platform === "win32")(
  "abort kills a held helper before reset finishes and the replacement can observe",
  async () => {
    const bridge = await fixture(
      `if(r.app==='ready')console.log(JSON.stringify({ok:true,result:{id:String(process.pid),app:r.app,windowTitle:'test',text:'ready'}}));`,
    );
    const first = await bridge.observe({ app: "ready" }, AbortSignal.timeout(5000));
    const controller = new AbortController();
    const pending = bridge.observe({ app: "held" }, controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    controller.abort();
    await rejected;
    expect(() => process.kill(Number(first.id), 0)).toThrow();
    const next = await bridge.observe({ app: "ready" }, AbortSignal.timeout(5000));
    expect(next.id).not.toBe(first.id);
  },
);

test.skipIf(process.platform === "win32")(
  "accepts a window screenshot larger than the former AX-only transport limit",
  async () => {
    const bridge = await fixture(
      `console.log(JSON.stringify(r.operation==='observe'?{ok:true,result:{id:'one',app:r.app,windowTitle:'test',text:'tree',windowId:42,bounds:{x:100,y:80,width:600,height:400},cursor:null}}:{ok:true,result:{layout:{id:'window:42',revision:'bounds',bounds:{x:100,y:80,width:600,height:400}},width:600,height:400,image:{type:'image',data:'a'.repeat(700000),mimeType:'image/png'}}}));`,
    );
    const state = await bridge.observe({ app: "test" }, AbortSignal.timeout(5000));
    expect(state.cursor).toBeUndefined();
    const image = await bridge.capture(state, AbortSignal.timeout(5000));
    expect(image.image.data).toHaveLength(700000);
    expect(image.layout.bounds.x).toBe(100);
  },
);

test.skipIf(process.platform === "win32")(
  "cancellation waits for cooperative native cleanup before admitting a replacement",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "eta-native-drain-"));
    directories.push(directory);
    const started = join(directory, "started"),
      cleaned = join(directory, "cleaned");
    const bridge = await fixture(
      `if(r.app==='held'){require('node:fs').writeFileSync(${JSON.stringify(started)},'ready');setInterval(()=>{},1000);process.once('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(cleaned)},'released');process.exit(0)},60));}else console.log(JSON.stringify({ok:true,result:{id:String(process.pid),app:r.app,windowTitle:'test',text:'ready'}}));`,
    );
    const controller = new AbortController();
    const pending = bridge.observe({ app: "held" }, controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    try {
      await expect
        .poll(async () => readFile(started, "utf8").catch(() => ""), { timeout: 3000 })
        .toBe("ready");
      controller.abort();
      await rejected;
      expect(await readFile(cleaned, "utf8")).toBe("released");
      expect((await bridge.observe({ app: "new" }, AbortSignal.timeout(5000))).app).toBe("new");
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  },
);

test.skipIf(process.platform === "win32")(
  "forced termination poisons the bridge instead of assuming held input was released",
  async () => {
    const bridge = await fixture(
      `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log(JSON.stringify({ok:true,result:{id:'one',app:r.app,windowTitle:'test',text:'ready'}}));`,
    );
    await bridge.observe({ app: "ready" }, AbortSignal.timeout(5000));
    await expect(bridge.reset()).rejects.toMatchObject({ applied: "unknown" });
    expect(() => bridge.assertHealthy()).toThrow("重启");
    await expect(bridge.observe({ app: "replacement" }, AbortSignal.timeout(5000))).rejects.toThrow(
      "重启",
    );
  },
  10000,
);

test.skipIf(process.platform === "win32")(
  "retains the native screenshot scope when off-Space child windows are excluded",
  async () => {
    const bridge = await fixture(
      `console.log(JSON.stringify({ok:true,result:r.operation==='observe'?{id:'one',app:r.app,windowTitle:'test',text:'[1] AXMenu'}:{excludesChildWindows:true,layout:{id:'window',revision:'one',bounds:{x:0,y:0,width:20,height:20}},width:20,height:20,image:{type:'image',data:'test',mimeType:'image/png'}}}));`,
    );
    const signal = AbortSignal.timeout(5000);
    const state = await bridge.observe({ app: "TextEdit" }, signal);
    expect((await bridge.capture(state, signal)).excludesChildWindows).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "interleaved native pointer telemetry does not resolve or lose the pending operation reply",
  async () => {
    const pointers: unknown[] = [];
    const bridge = await fixture(
      `console.log(JSON.stringify({event:'pointer',snapshot:'one',windowId:42,point:{x:4,y:5},bounds:{x:0,y:0,width:20,height:20},phase:'up',visible:true})+'\\n'+JSON.stringify({ok:true,result:{id:'one',app:r.app,windowTitle:'test',text:'ready'}}));`,
      (event) => pointers.push(event),
    );
    const state = await bridge.observe({ app: "test" }, AbortSignal.timeout(5000));
    expect(state.id).toBe("one");
    expect(pointers).toMatchObject([{ snapshot: "one", windowId: 42, phase: "up", visible: true }]);
  },
);

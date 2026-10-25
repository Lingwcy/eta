import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { defineTool } from "@eta/agent";
import type { JsonValue } from "@earendil-works/chord";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore } from "../../../src/client.ts";
import type { CoreClient } from "../../../src/client.ts";
import type { RuntimeSettings } from "../../../src/shared/runtime-settings.ts";
import { RuntimeCodemodeSandbox } from "../../../src/service/runtime/codemode.ts";
import type { ImageProcessor } from "../../../src/images/types.ts";
import type { CoreEnvironment } from "../../../src/service/environment.ts";
import { ComputerService } from "@eta/computer-use/service";
import { ComputerError } from "@eta/computer-use/protocol";
import type { ComputerInput } from "@eta/computer-use/protocol";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(
  initial: Partial<RuntimeSettings> = {},
  processImage?: ImageProcessor,
  environment: Partial<CoreEnvironment> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "eta-codemode-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "code-test",
    models: [
      { id: "one", input: ["text", "image"], inputLimits: { images: { maxPerMessage: 1 } } },
    ],
    tokensPerSecond: 100000,
  });
  const titles = fauxProvider({
    provider: "code-test",
    models: [{ id: "one" }],
    tokensPerSecond: 100000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  let settings: RuntimeSettings = {
    defaultThinkingLevel: "off",
    computerUse: Boolean(environment.computer),
    ...initial,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<RuntimeSettings>) => {
    settings = { ...settings, ...patch };
    for (const listener of listeners) listener();
  };
  const open = async () => {
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      processImage,
      settings: {
        read: Effect.sync(() => settings),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      environment: { shutdown: "preserve", ...environment },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id);
  const run = async (client = core) => {
    const admission = await client.submit(thread.id, "Run tools");
    await expect
      .poll(
        async () =>
          ["completed", "failed", "aborted"].includes(
            (await client.operation(thread.id, admission.operationId)).status,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const result = await client.operation(thread.id, admission.operationId);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    return client.openThread(thread.id);
  };
  return { core, thread, provider, update, run, open, cwd };
}

const script = (code: string) =>
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });

test.each(["standard", "codemode"] as const)(
  "desktop guidance is present before tool discovery and revoked with permissions in %s",
  async (agentMode) => {
    const service = new ComputerService({
      layout: async () => {
        throw new Error("unexpected desktop access");
      },
      capture: async () => {
        throw new Error("unexpected desktop access");
      },
      input: async () => {
        throw new Error("unexpected desktop access");
      },
      releaseInputs: async () => {},
    });
    const f = await fixture({ agentMode }, undefined, {
      computer: { service, enabled: () => true },
    });
    for (const patch of [
      { computerUse: true, blockImages: false },
      { computerUse: false, blockImages: false },
      { computerUse: true, blockImages: true },
      { computerUse: true, blockImages: false },
    ]) {
      f.update(patch);
      f.provider.setResponses([
        (request) => {
          const prompt = getCurrentSystemPrompt(request.messages);
          expect(prompt.includes("<computer-use>")).toBe(patch.computerUse && !patch.blockImages);
          if (patch.computerUse && !patch.blockImages) {
            expect(prompt).toContain("tools.computer({action:'observe'");
            expect(prompt).toContain("Every input already returns an updated accessibility tree");
          }
          if (agentMode === "codemode")
            expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
              "codemode",
            ]);
          return fauxAssistantMessage("Guidance checked");
        },
      ]);
      await f.run();
    }
  },
  30000,
);

test("computer screenshots reach the main model, and a later run cannot reuse its frame", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
  const layout = { id: "test", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
  const inputs: ComputerInput[] = [];
  const service = new ComputerService({
    layout: async () => layout,
    capture: async () => ({
      image: { type: "image", data: png, mimeType: "image/png" },
      width: 1,
      height: 1,
      layout,
    }),
    input: async (input) => {
      inputs.push(input);
    },
    releaseInputs: async () => {},
  });
  const f = await fixture({}, undefined, { computer: { service, enabled: () => true } });
  f.provider.setResponses([
    script(
      'const r=await tools.computer({action:"screenshot"}); if(!r.ok) throw Error(r.error.message); store("frame",r.frame.id); text({frame:r.frame}); image(r.image);',
    ),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      expect(result?.role).toBe("toolResult");
      if (result?.role === "toolResult") {
        expect(result.content.filter((part) => part.type === "image")).toEqual([
          { type: "image", data: png, mimeType: "image/png" },
        ]);
        expect(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ).not.toContain(png);
      }
      return script(
        'const r=await tools.computer({action:"click",frameId:load("frame"),point:{x:0,y:0}}); if(!r.ok) throw Error(r.error.message); image(r.image);',
      );
    },
    fauxAssistantMessage("Desktop observed and clicked"),
  ]);
  const completed = await f.run();
  expect(inputs, JSON.stringify(completed)).toHaveLength(1);
  f.provider.setResponses([
    script(
      'const r=await tools.computer({action:"click",frameId:load("frame"),point:{x:0,y:0}}); text(r);',
    ),
    fauxAssistantMessage("Old frame rejected"),
  ]);
  expect(JSON.stringify(await f.run())).toContain("stale_frame");
  expect(inputs).toHaveLength(1);
}, 30000);

test.each([true, false])(
  "standard computer calls honor blockImages=%s before capturing",
  async (blocked) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    let captures = 0;
    const layout = { id: "one", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => {
        captures++;
        return {
          width: 1,
          height: 1,
          layout,
          image: { type: "image", data: png, mimeType: "image/png" },
        };
      },
      input: async () => {
        throw new Error("unexpected input");
      },
      releaseInputs: async () => {},
    });
    const f = await fixture({ agentMode: "standard", blockImages: blocked }, undefined, {
      computer: { service, enabled: () => true },
    });
    let checked = false;
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        expect(result?.role).toBe("toolResult");
        if (result?.role === "toolResult")
          expect(result.content.filter((part) => part.type === "image")).toHaveLength(
            blocked ? 0 : 1,
          );
        checked = true;
        return fauxAssistantMessage("Checked");
      },
    ]);
    await f.run();
    expect(captures).toBe(blocked ? 0 : 1);
    expect(checked).toBe(true);
  },
);

test.each(["standard", "codemode"] as const)(
  "orchestrator keeps desktop control with the main agent in %s",
  async (mode) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    const layout = { id: "one", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
    let captures = 0;
    let checked = false;
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => {
        captures++;
        return {
          width: 1,
          height: 1,
          layout,
          image: { type: "image", data: png, mimeType: "image/png" },
        };
      },
      input: async () => {
        throw new Error("unexpected input");
      },
      releaseInputs: async () => {},
    });
    const f = await fixture(
      {
        agentMode: mode,
        subagents: { mode: "orchestrator", maxDepth: 2, maxConcurrent: 2, presets: [] },
      },
      undefined,
      { computer: { service, enabled: () => true } },
    );
    f.provider.setResponses([
      (context) => {
        expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain(
          mode === "standard" ? "computer" : "codemode",
        );
        checked = true;
        return mode === "codemode"
          ? script(
              'const r=await tools.computer({action:"screenshot"}); if(!r.ok) throw Error(r.error.message); image(r.image);',
            )
          : fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), {
              stopReason: "toolUse",
            });
      },
      fauxAssistantMessage("Observed"),
    ]);
    const completed = await f.run();
    expect(checked, JSON.stringify(completed)).toBe(true);
    expect(captures, JSON.stringify(completed)).toBe(1);
  },
);

test("computer parameter failures explain recovery without blaming Code mode", async () => {
  let captured = false;
  let checked = false;
  const service = new ComputerService({
    layout: async () => {
      throw Error("unexpected layout");
    },
    capture: async () => {
      captured = true;
      throw Error("unexpected capture");
    },
    input: async () => {
      throw Error("unexpected input");
    },
    releaseInputs: async () => {},
  });
  const f = await fixture({}, undefined, { computer: { service, enabled: () => true } });
  f.provider.setResponses([
    script(
      'const r=await tools.computer({action:"type",text:"no frame"});text(r);if(!r.ok)throw Error(r.error.message);',
    ),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      const text =
        result?.role === "toolResult"
          ? result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          : "";
      expect(text).toContain("type requires frameId");
      expect(text).not.toContain("切换普通模式");
      checked = true;
      return fauxAssistantMessage("Parameters corrected");
    },
  ]);
  const result = await f.run();
  expect(checked, JSON.stringify(result)).toBe(true);
  expect(captured).toBe(false);
});

test.each(["standard", "codemode"] as const)(
  "%s keeps user takeover stopped across model rounds and permits a new user admission",
  async (mode) => {
    let observations = 0;
    const service = new ComputerService({
      layout: async () => {
        throw Error("unexpected layout");
      },
      capture: async () => {
        throw Error("unexpected capture");
      },
      input: async () => {
        throw Error("unexpected input");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async (target) => {
          if (++observations === 1)
            throw new ComputerError("user_interrupted", "User took over the target app");
          return {
            id: "new-admission",
            app: target.app,
            windowTitle: "test",
            text: "[1] AXTextField",
          };
        },
        input: async () => {
          throw Error("unexpected AX input");
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    const call = (action: "observe" | "release") =>
      mode === "codemode"
        ? script(
            `text(await tools.computer(${JSON.stringify(action === "observe" ? { action, app: "TextEdit" } : { action })}));`,
          )
        : fauxAssistantMessage(
            fauxToolCall(
              "computer",
              action === "observe" ? { action, app: "TextEdit" } : { action },
            ),
            { stopReason: "toolUse" },
          );
    const checkStopped = (context: { messages: unknown[] }) => {
      expect(JSON.stringify(context.messages.at(-1))).toContain("Stop computer-use for this task");
      expect(JSON.stringify(context.messages.at(-1))).toContain("user_interrupted");
      expect(JSON.stringify(context.messages.at(-1))).toContain("applied");
    };
    f.provider.setResponses([
      call("observe"),
      (context) => {
        checkStopped(context);
        return call("observe");
      },
      (context) => {
        checkStopped(context);
        return call("release");
      },
      () => call("observe"),
      (context) => {
        checkStopped(context);
        return fauxAssistantMessage("Waiting for user");
      },
    ]);
    await f.run();
    expect(observations).toBe(1);
    f.provider.setResponses([
      call("observe"),
      (context) => {
        expect(JSON.stringify(context.messages.at(-1))).toContain("AXTextField");
        return fauxAssistantMessage("New user task can use the app");
      },
    ]);
    await f.run();
    expect(observations).toBe(2);
  },
  30000,
);

test.each(["standard", "codemode"] as const)(
  "%s re-observes after manual interaction within the same user submission",
  async (mode) => {
    let observations = 0;
    const service = new ComputerService({
      layout: async () => {
        throw Error("unexpected layout");
      },
      capture: async () => {
        throw Error("unexpected capture");
      },
      input: async () => {
        throw Error("unexpected input");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async (target) => {
          if (++observations === 1)
            throw new ComputerError("stale_frame", "Manual interaction", "unknown");
          return { id: "fresh", app: target.app, windowTitle: "test", text: "[1] AXTextField" };
        },
        input: async () => {
          throw Error("unexpected AX input");
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    const observe = () =>
      mode === "codemode"
        ? script('text(await tools.computer({action:"observe",app:"TextEdit"}));')
        : fauxAssistantMessage(fauxToolCall("computer", { action: "observe", app: "TextEdit" }), {
            stopReason: "toolUse",
          });
    f.provider.setResponses([
      observe(),
      (context) => {
        const result = JSON.stringify(context.messages.at(-1));
        expect(result).toContain("stale_frame");
        expect(result).toContain("Observe the target again");
        expect(result).not.toContain("Stop computer-use for this task");
        return observe();
      },
      (context) => {
        expect(JSON.stringify(context.messages.at(-1))).toContain("AXTextField");
        return fauxAssistantMessage("Continue together");
      },
    ]);
    await f.run();
    expect(observations).toBe(2);
  },
  30000,
);

test.each(["standard", "codemode"] as const)(
  "%s admits a menu-bar target through the chat tool schema",
  async (mode) => {
    const targets: unknown[] = [];
    const service = new ComputerService({
      layout: async () => {
        throw Error("unexpected layout");
      },
      capture: async () => {
        throw Error("unexpected capture");
      },
      input: async () => {
        throw Error("unexpected input");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async (target) => {
          targets.push(target);
          return {
            id: "status",
            app: target.app,
            windowTitle: "magpie menu bar",
            text: "[0] AXMenuBarItem actions=AXPress",
          };
        },
        input: async () => {
          throw Error("unexpected AX input");
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    const args = { action: "observe", app: "magpie", surface: "menu_bar" };
    f.provider.setResponses([
      mode === "codemode"
        ? script(`text(await tools.computer(${JSON.stringify(args)}));`)
        : fauxAssistantMessage(fauxToolCall("computer", args), { stopReason: "toolUse" }),
      (context) => {
        expect(JSON.stringify(context.messages.at(-1))).toContain("AXMenuBarItem");
        return fauxAssistantMessage("Status item found");
      },
    ]);
    await f.run();
    expect(targets).toEqual([{ app: "magpie", surface: "menu_bar" }]);
  },
  30000,
);

test.each(["standard", "codemode"] as const)(
  "%s holds all chord modifiers before Enter reaches the computer adapter",
  async (mode) => {
    const inputs: ComputerInput[] = [];
    const service = new ComputerService({
      layout: async () => {
        throw Error("unexpected layout");
      },
      capture: async () => {
        throw Error("unexpected capture");
      },
      input: async () => {
        throw Error("unexpected global input");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async (target) => ({
          id: "one",
          app: target.app,
          windowTitle: "test",
          text: "[0] AXTextField",
        }),
        input: async (_state, input) => {
          inputs.push(input);
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    f.provider.setResponses([
      mode === "codemode"
        ? script(
            'const r=await tools.computer({action:"observe",app:"TextEdit"});if(!r.ok)throw Error(r.error.message);store("frame",r.frame.id);text(r);',
          )
        : fauxAssistantMessage(fauxToolCall("computer", { action: "observe", app: "TextEdit" }), {
            stopReason: "toolUse",
          }),
      (context) => {
        if (mode === "codemode")
          return script(
            'const r=await tools.computer({action:"key",frameId:load("frame"),keys:["ENTER","command","CTRL","control"]});if(!r.ok)throw Error(r.error.message);text(r);',
          );
        const message = context.messages.at(-1)!;
        if (message.role !== "toolResult") throw Error("Expected observation result");
        const content = message.content.find((part) => part.type === "text");
        if (!content || content.type !== "text") throw Error("Missing observation metadata");
        const { frame } = JSON.parse(content.text);
        return fauxAssistantMessage(
          fauxToolCall("computer", {
            action: "key",
            frameId: frame.id,
            keys: ["ENTER", "command", "CTRL", "control"],
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Chord completed"),
    ]);
    const result = await f.run();
    expect(inputs, JSON.stringify(result)).toEqual([
      { action: "key", keys: ["cmd", "control", "return"] },
    ]);
  },
  30000,
);

test.each([false, true])(
  "known click/type/submit has bounded observations and model rounds (composite=%s)",
  async (combined) => {
    let captures = 0;
    const inputs: ComputerInput[] = [];
    const layout = { id: "one", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => {
        captures++;
        return {
          width: 1,
          height: 1,
          layout,
          image: {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
          },
        };
      },
      input: async (input) => {
        inputs.push(input);
      },
      releaseInputs: async () => {},
    });
    const f = await fixture({}, undefined, { computer: { service, enabled: () => true } });
    const action = (parameters: string) =>
      script(
        `const r=await tools.computer(${parameters});if(!r.ok)throw Error(r.error.message);store("frame",r.frame.id);image(r.image);`,
      );
    f.provider.setResponses([
      action('{action:"screenshot"}'),
      ...(combined
        ? [action('{action:"type",frameId:load("frame"),point:{x:0,y:0},text:"你好",enter:true}')]
        : [
            action('{action:"click",frameId:load("frame"),point:{x:0,y:0}}'),
            action('{action:"type",frameId:load("frame"),text:"你好"}'),
            action('{action:"key",frameId:load("frame"),keys:["ENTER"]}'),
          ]),
      fauxAssistantMessage("Completed"),
    ]);
    const result = await f.run();
    expect(inputs, JSON.stringify(result)).toHaveLength(combined ? 1 : 3);
    if (combined) expect(inputs[0]).toMatchObject({ action: "type", text: "你好", enter: true });
    expect({ captures, rounds: f.provider.state.callCount }).toEqual(
      combined ? { captures: 2, rounds: 3 } : { captures: 4, rounds: 5 },
    );
  },
  30000,
);

test.each(["standard", "codemode"] as const)(
  "%s bounds desktop images in provider input while preserving history",
  async (mode) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    const layout = { id: "one", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => ({
        width: 1,
        height: 1,
        layout,
        image: { type: "image", data: png, mimeType: "image/png" },
      }),
      input: async () => {
        throw new Error("unexpected input");
      },
      releaseInputs: async () => {},
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    let checked = false;
    f.provider.setResponses([
      ...Array.from({ length: 6 }, () =>
        mode === "codemode"
          ? script(
              'const r=await tools.computer({action:"screenshot"}); if(!r.ok) throw Error(r.error.message); image(r.image);',
            )
          : fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), {
              stopReason: "toolUse",
            }),
      ),
      (context) => {
        const results = context.messages.filter((message) => message.role === "toolResult");
        expect(results).toHaveLength(6);
        expect(
          results.flatMap((message) => message.content).filter((part) => part.type === "image"),
        ).toHaveLength(4);
        checked = true;
        return fauxAssistantMessage("Budget checked");
      },
    ]);
    const completed = await f.run();
    expect(checked, JSON.stringify(completed)).toBe(true);
    // The request hook projects input; all six durable tool results still contain their images.
    const history = JSON.stringify(completed);
    expect(history.split(png).length - 1).toBeGreaterThanOrEqual(6);
  },
  30000,
);

test("default Code mode executes sequential and parallel native tools, then switches both ways on the same thread", async () => {
  const f = await fixture();
  f.provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      expect(getCurrentSystemPrompt(context.messages)).toContain("<codemode>");
      return script(
        'await Promise.all([tools.write({path:"a.txt",content:"A"}),tools.write({path:"b.txt",content:"B"})]); text(await tools.read({path:"a.txt"}));',
      );
    },
    fauxAssistantMessage("Code complete"),
  ]);
  const result = await f.run();
  expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("A");
  expect(await readFile(join(f.cwd, "b.txt"), "utf8")).toBe("B");
  expect(JSON.stringify(result)).toContain("Code complete");
  f.update({ agentMode: "standard" });
  f.provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).some((tool) => tool.name === "write")).toBe(true);
      expect(getCurrentTools(context.messages).some((tool) => tool.name === "codemode")).toBe(
        false,
      );
      expect(getCurrentSystemPrompt(context.messages)).not.toContain("<codemode>");
      return fauxAssistantMessage(fauxToolCall("write", { path: "standard.txt", content: "S" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Standard complete"),
  ]);
  await f.run();
  expect(await readFile(join(f.cwd, "standard.txt"), "utf8")).toBe("S");
  f.update({ agentMode: "codemode" });
  f.provider.setResponses([script('text("back");'), fauxAssistantMessage("Back")]);
  expect(JSON.stringify(await f.run())).toContain("back");
}, 30000);

test("scripts cannot call disabled tools or upstream model globals", async () => {
  const f = await fixture();
  f.update({ disabledTools: ["write"] });
  f.provider.setResponses([
    script(
      'text(ALL_TOOLS); try { await tools.write({path:"forbidden",content:"bad"}); } catch(e) { text(e.message); } text(typeof models);',
    ),
    fauxAssistantMessage("Checked"),
  ]);
  const result = await f.run();
  expect(JSON.stringify(result)).toContain("undefined");
  await expect(readFile(join(f.cwd, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a paused nested approval survives settings changes and reopening in its original mode", async () => {
  const f = await fixture();
  f.update({ defaultSandboxMode: "read-only" });
  // The default sandbox is selected at thread creation; create another thread for this policy.
  const project = (await f.core.projects())[0]!;
  const workspace = (await f.core.workspaces(project.id))[0]!;
  const thread = await f.core.createThread(workspace.id);
  f.provider.setResponses([
    script('await tools.write({path:"approval.txt",content:"approved"}); text("written");'),
    fauxAssistantMessage("Done"),
  ]);
  const admission = await f.core.submit(thread.id, "Write with approval");
  await expect
    .poll(async () => (await f.core.openThread(thread.id)).snapshot.approvals?.length, {
      timeout: 15000,
    })
    .toBe(1);
  const waiting = (await f.core.openThread(thread.id)).snapshot;
  expect(waiting.operation?.runningTools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toolName: "write",
        status: "waiting",
        parentToolCallId: expect.any(String),
        parentTaskId: expect.any(String),
      }),
    ]),
  );
  f.update({ agentMode: "standard" });
  await f.core.close();
  const reopened = await f.open();
  expect((await reopened.openThread(thread.id)).snapshot.recoveryRequired).toBe(true);
  await reopened.resume(thread.id);
  await expect
    .poll(async () => (await reopened.openThread(thread.id)).snapshot.approvals?.length, {
      timeout: 15000,
    })
    .toBe(1);
  const request = (await reopened.openThread(thread.id)).snapshot.approvals![0]!;
  await reopened.decideApproval(thread.id, request.id, true);
  await expect
    .poll(async () => (await reopened.operation(thread.id, admission.operationId)).status, {
      timeout: 15000,
    })
    .toBe("completed");
  expect(await readFile(join(f.cwd, "approval.txt"), "utf8")).toBe("approved");
}, 40000);

test("host timeout caps an unbounded script and close aborts outstanding workers", async () => {
  const sandbox = new RuntimeCodemodeSandbox();
  try {
    const result = await sandbox.start("while(true) {}", {
      startedAt: Date.now() - 300000 + 50,
      seed: 1,
      timeoutMs: Infinity,
      onCall() {},
    }).result;
    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    const run = sandbox.start("while(true) {}", { startedAt: Date.now(), seed: 2, onCall() {} });
    await sandbox.close();
    expect(await run.result).toMatchObject({ ok: false, error: { kind: "aborted" } });
  } finally {
    await sandbox.close();
  }
});

test("children inherit the admitted mode after preferences change and retain their tool restrictions", async () => {
  let captures = 0;
  const service = new ComputerService({
    layout: async () => {
      throw new Error("unexpected layout");
    },
    capture: async () => {
      captures++;
      throw new Error("unexpected capture");
    },
    input: async () => {
      throw new Error("unexpected input");
    },
    releaseInputs: async () => {},
  });
  const f = await fixture({}, undefined, { computer: { service, enabled: () => true } });
  f.provider.setResponses([
    () => {
      f.update({ agentMode: "standard" });
      return script(
        'text(await tools.subagent({action:"spawn",name:"worker",message:"Write child.txt",wait:true}));',
      );
    },
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      return script(
        'if(ALL_TOOLS.some(t=>["schedule","subagent","computer"].includes(t.name))) throw Error("restricted tool exposed"); await tools.write({path:"child.txt",content:"inherited"});',
      );
    },
    fauxAssistantMessage("Child done"),
    fauxAssistantMessage("Parent done"),
    fauxAssistantMessage("Report received"),
  ]);
  const result = await f.run();
  expect(await readFile(join(f.cwd, "child.txt"), "utf8")).toBe("inherited");
  expect(captures).toBe(0);
  expect(result.snapshot.configuration.agentMode).toBe("codemode");
  expect(result.snapshot.subagents).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "completed" })]),
  );
}, 30000);

test("scripts activate and remove skills and create schedules through the existing tools", async () => {
  const f = await fixture();
  const skill = join(f.cwd, ".agents/skills/check");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: check\ndescription: Check work\n---\nCODE_SKILL_INSTRUCTIONS",
  );
  f.provider.setResponses([
    script('text(await tools.load_skill({name:"check"}));'),
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("CODE_SKILL_INSTRUCTIONS");
      return script('text(await tools.unload_skill({name:"check"}));');
    },
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).not.toContain("CODE_SKILL_INSTRUCTIONS");
      return fauxAssistantMessage("Skills checked");
    },
  ]);
  await f.run();
  f.provider.setResponses([
    script(
      `text(await tools.schedule({action:"create",name:"Code plan",prompt:"Check work",rule:{type:"once",at:${Date.now() + 3600000}}}));`,
    ),
    fauxAssistantMessage("Scheduled"),
  ]);
  const opened = await f.run();
  const scheduledResult = opened.snapshot.transcript.findLast(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  );
  if (scheduledResult?.message.role !== "toolResult") throw Error("Missing schedule script");
  expect(scheduledResult.message.details).toMatchObject({
    calls: [
      {
        name: "schedule",
        taskId: expect.any(String),
        parentTaskId: expect.any(String),
        result: { details: { kind: "schedule", action: "create", status: "applied" } },
      },
    ],
  });
  expect(await f.core.listSchedules()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Code plan" })]),
  );
}, 30000);

test("nested rejection and cancellation do not write files", async () => {
  const f = await fixture({ defaultSandboxMode: "read-only" });
  for (const stop of [false, true]) {
    f.provider.setResponses([
      script('await tools.write({path:"denied.txt",content:"bad"});'),
      fauxAssistantMessage("Handled"),
    ]);
    const admission = await f.core.submit(f.thread.id, "Try writing");
    await expect
      .poll(async () => (await f.core.openThread(f.thread.id)).snapshot.approvals?.length, {
        timeout: 15000,
      })
      .toBe(1);
    if (stop) await f.core.stop(f.thread.id);
    else {
      const request = (await f.core.openThread(f.thread.id)).snapshot.approvals![0]!;
      await f.core.decideApproval(f.thread.id, request.id, false);
    }
    await expect
      .poll(async () => (await f.core.operation(f.thread.id, admission.operationId)).status, {
        timeout: 15000,
      })
      .toBe(stop ? "aborted" : "completed");
    await expect(readFile(join(f.cwd, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30000);

test.each([false, true])(
  "image reads preserve processor notes, enforce the model image limit and respect blocking (processor=%s)",
  async (processed) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    const f = await fixture(
      {},
      processed
        ? async () => ({
            type: "image",
            data: png,
            mimeType: "image/png",
            note: "Coordinates use the resized image.",
          })
        : undefined,
    );
    await writeFile(join(f.cwd, "image.png"), Buffer.from(png, "base64"));
    for (const blockImages of [false, true]) {
      f.update({ blockImages });
      f.provider.setResponses([
        script(
          `await tools.read({path:"image.png"}); await tools.read({path:"image.png"}); image("data:image/png;base64,${png}");`,
        ),
        (context) => {
          const last = context.messages.findLast((message) => message.role === "toolResult");
          expect(last?.role).toBe("toolResult");
          const content = last && Array.isArray(last.content) ? last.content : [];
          expect(content.filter((part) => part.type === "image")).toHaveLength(blockImages ? 0 : 1);
          if (processed)
            expect(JSON.stringify(content)).toContain("Coordinates use the resized image.");
          expect(JSON.stringify(content)).toContain("Image limit reached");
          return fauxAssistantMessage("Image checked");
        },
      ]);
      await f.run();
    }
  },
  30000,
);

test("nested previews preserve structured JSON values without interpreting content-like records", async () => {
  const values: JsonValue[] = [
    0,
    false,
    null,
    [],
    [1, 2],
    { type: "record", count: 7 },
    { type: "text", text: "A structured record, not a display block" },
    [{ type: "text", text: "A structured array, not display content" }],
    "",
    "plain string",
  ];
  const tool = defineTool({
    name: "structured_preview",
    description: "Return a structured JSON value",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0, maximum: values.length - 1 }) }),
    structuredOutputSchema: Type.Unknown(),
    execute: async ({ index }) => ({ structuredOutput: values[index]! }),
  });
  const f = await fixture({}, undefined, {
    extensions: () => [{ name: "structured-preview-test", tools: [tool] }],
  });
  f.provider.setResponses([
    script(`
      const expected = ${JSON.stringify(values)};
      const actual = await Promise.all(expected.map((_, index) => tools.structured_preview({index})));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("Bridge lost JSON");
      text("All structured values intact");
    `),
    fauxAssistantMessage("Checked previews"),
  ]);
  const opened = await f.run();
  const result = opened.snapshot.transcript.find(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  )?.message;
  if (result?.role !== "toolResult") throw Error("Missing Code mode result");
  expect(result.isError, JSON.stringify(result)).toBe(false);
  const details = Schema.decodeUnknownSync(
    Schema.Struct({
      calls: Schema.Array(
        Schema.Struct({
          result: Schema.Struct({
            content: Schema.Array(
              Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
            ),
          }),
        }),
      ),
    }),
  )(result.details);
  expect(details.calls).toHaveLength(values.length);
  for (const [index, call] of details.calls.entries()) {
    expect(
      call.result.content,
      `Missing structured preview for ${JSON.stringify(values[index])}`,
    ).toHaveLength(1);
    expect(JSON.parse(call.result.content[0]!.text)).toEqual(values[index]);
  }
}, 20000);

test("structured tool failures remain inspectable and oversized script output spills to a file", async () => {
  const f = await fixture();
  f.provider.setResponses([
    script(
      '// @options: {"max_output_tokens": 100}\nconst result = await tools.bash({command:"exit 7"}); if(result.exitCode!==7) throw Error("lost structured exit"); text("x".repeat(10000));',
    ),
    fauxAssistantMessage("Checked output"),
  ]);
  const opened = await f.run();
  const result = opened.snapshot.transcript.find(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  );
  expect(result?.message.role).toBe("toolResult");
  if (result?.message.role !== "toolResult") throw Error("Missing script result");
  expect(result.message.isError, JSON.stringify(result.message)).toBe(false);
  expect(result.message.details).toMatchObject({
    fullOutputPath: expect.any(String),
    calls: [expect.objectContaining({ name: "bash", status: "error" })],
  });
}, 20000);

test("the worker rejects allocations beyond the host memory cap", async () => {
  const sandbox = new RuntimeCodemodeSandbox();
  try {
    const result = await sandbox.start("new Uint8Array(256 * 1024 * 1024);", {
      startedAt: Date.now(),
      seed: 1,
      timeoutMs: 5000,
      onCall() {},
    }).result;
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "script", message: expect.stringMatching(/memory/i) },
    });
  } finally {
    await sandbox.close();
  }
});

test("worker capacity is shared across thread sandboxes", async () => {
  const sandboxes = Array.from({ length: 5 }, () => new RuntimeCodemodeSandbox());
  try {
    for (const sandbox of sandboxes.slice(0, 4)) {
      let ready!: () => void;
      const called = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const run = sandbox.start("await tools.hold({});", {
        startedAt: Date.now(),
        seed: 1,
        tools: [{ name: "hold" }],
        timeoutMs: 10000,
        onCall: ready,
      });
      await Promise.race([
        called,
        run.result.then((result) => {
          throw Error(`Worker ended before hold: ${JSON.stringify(result)}`);
        }),
      ]);
    }
    const denied = await sandboxes[4]!.start("text('over capacity');", {
      startedAt: Date.now(),
      seed: 1,
      timeoutMs: 5000,
      onCall() {},
    }).result;
    expect(denied).toMatchObject({
      ok: false,
      error: { kind: "sandbox", message: expect.stringContaining("并发已满") },
    });
  } finally {
    await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
  }
}, 20000);

test("unavailable Code mode reports how to switch modes and leaves standard mode usable", async () => {
  const f = await fixture({}, undefined, {
    codemodeAssets: {
      worker: join(tmpdir(), "eta-missing-codemode-worker.mjs"),
      wasm: join(tmpdir(), "eta-missing-codemode.wasm"),
    },
  });
  f.provider.setResponses([
    script('text("cannot run");'),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("权限切换普通模式");
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      return fauxAssistantMessage("Reported missing resources");
    },
  ]);
  expect((await f.run()).snapshot.configuration.agentMode).toBe("codemode");
  f.update({ agentMode: "standard" });
  f.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "standard-fallback.txt", content: "manual choice" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Standard works"),
  ]);
  await f.run();
  expect(await readFile(join(f.cwd, "standard-fallback.txt"), "utf8")).toBe("manual choice");
}, 20000);

test("intent summaries survive native Code mode, truncated nested previews, mode switches and history reopening", async () => {
  const f = await fixture({ defaultSandboxMode: "danger-full-access" });
  const code =
    'await tools.write({path:"intent.txt",content:"x".repeat(5000),description:"保存验证内容"}); text(await tools.read({path:"intent.txt",description:"读取验证内容"}));';
  f.provider.setResponses([
    (request) => {
      const declared = getCurrentTools(request.messages).find((tool) => tool.name === "codemode")!;
      expect(declared.parameters).toHaveProperty("required", ["description", "code"]);
      expect(declared.constrainedSampling).toBeUndefined();
      return fauxAssistantMessage(
        fauxToolCall("codemode", { description: "验证文件读写", code }, { id: "intent-code" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Verified"),
  ]);
  const result = await f.run();
  expect(result.snapshot.toolIntents?.["intent-code"]).toBe("验证文件读写");
  const nested = result.snapshot.transcript.find(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  )!.message;
  if (nested.role !== "toolResult") throw Error("Missing code result");
  const details = Schema.decodeUnknownSync(
    Schema.Struct({
      calls: Schema.Array(
        Schema.Struct({ name: Schema.String, args: Schema.String, description: Schema.String }),
      ),
    }),
  )(nested.details);
  expect(details.calls.map((call) => call.description)).toEqual(["保存验证内容", "读取验证内容"]);
  expect(details.calls[0]!.args).not.toContain("保存验证内容");
  expect(await readFile(join(f.cwd, "intent.txt"), "utf8")).toBe("x".repeat(5000));
  f.update({ agentMode: "standard" });
  f.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "read",
        { path: "intent.txt", description: "检查保存结果" },
        { id: "intent-read" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Read verified"),
  ]);
  await f.run();
  const reopened = await f.core.openThread(f.thread.id);
  expect(reopened.snapshot.toolIntents).toMatchObject({
    "intent-code": "验证文件读写",
    "intent-read": "检查保存结果",
  });
});

test("a sequential tool round distinguishes execution from queued calls while retaining both intents", async () => {
  let entered = false;
  const release = Promise.withResolvers<void>();
  const gate = defineTool({
    name: "intent_gate",
    description: "Hold one sequential call",
    executionMode: "sequential",
    parameters: Type.Object(
      { description: Type.Optional(Type.String()) },
      { "x-eta-tool-intent": true },
    ),
    execute: async () => {
      entered = true;
      await release.promise;
      return { output: [] };
    },
  });
  const f = await fixture(
    { agentMode: "standard", defaultSandboxMode: "danger-full-access" },
    undefined,
    { extensions: () => [{ name: "intent-test", tools: [gate] }] },
  );
  f.provider.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("intent_gate", { description: "等待测试放行" }, { id: "gate" }),
        fauxToolCall(
          "write",
          { description: "保存排队内容", path: "queued.txt", content: "queued" },
          { id: "queued" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const running = f.run();
  try {
    await expect.poll(() => entered, { timeout: 15000 }).toBe(true);
    const current = await f.core.openThread(f.thread.id);
    expect(current.snapshot.operation!.runningTools).toMatchObject([
      { toolCallId: "gate", status: "running", description: "等待测试放行" },
      { toolCallId: "queued", status: "pending" },
    ]);
    expect(current.snapshot.toolIntents).toMatchObject({
      gate: "等待测试放行",
      queued: "保存排队内容",
    });
  } finally {
    release.resolve();
    await running;
  }
  expect(await readFile(join(f.cwd, "queued.txt"), "utf8")).toBe("queued");
});

test.each(["standard", "codemode"] as const)(
  "%s reads AX controls, sets a value and observes the result without screenshots or a grounding request",
  async (mode) => {
    let text = "before";
    let captures = 0;
    let opened = 0;
    const inputs: ComputerInput[] = [];
    const layout = { id: "one", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => {
        captures++;
        throw Error("AX path must not capture an image");
      },
      input: async (input) => {
        if (input.action === "open") {
          opened++;
          return;
        }
        throw Error("AX input must not enter the global coordinate path");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async (target) => ({
          id: text,
          app: target.app,
          windowTitle: "test",
          text: `[3] AXTextField settable value=${text}`,
        }),
        input: async (state, input) => {
          expect(state.id).toBe("before");
          inputs.push(input);
          text = "中文";
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    let frameId = "";
    const call = (args: Record<string, JsonValue>, code: string) =>
      mode === "codemode"
        ? script(code)
        : fauxAssistantMessage(fauxToolCall("computer", args), { stopReason: "toolUse" });
    f.provider.setResponses([
      call(
        { action: "open", app: "TextEdit" },
        'const r=await tools.computer({action:"open",app:"TextEdit"});if(!r.ok)throw Error(r.error.message);text(r);',
      ),
      call(
        { action: "observe", app: "TextEdit", windowTitle: "test" },
        'const r=await tools.computer({action:"observe",app:"TextEdit",windowTitle:"test"});if(!r.ok)throw Error(r.error.message);store("frame",r.frame.id);text(r);',
      ),
      (context) => {
        const result = context.messages.at(-1)!;
        expect(result.role).toBe("toolResult");
        const content = result.role === "toolResult" ? result.content : [];
        expect(content.some((part) => part.type === "image")).toBe(false);
        const output = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        expect(output).toContain("AXTextField");
        if (mode === "standard") frameId = JSON.parse(output).frame.id;
        return call(
          { action: "set_value", frameId, elementIndex: 3, text: "中文" },
          'const r=await tools.computer({action:"set_value",frameId:load("frame"),elementIndex:3,text:"中文"});if(!r.ok)throw Error(r.error.message);text(r);',
        );
      },
      (context) => {
        const result = context.messages.at(-1)!;
        expect(JSON.stringify(result)).toContain("value=中文");
        return fauxAssistantMessage("Value verified");
      },
    ]);
    const result = await f.run();
    expect(inputs, JSON.stringify(result)).toEqual([
      { action: "set_value", elementIndex: 3, text: "中文" },
    ]);
    expect(captures).toBe(0);
    expect(opened).toBe(1);
    expect(f.provider.state.callCount).toBe(4);
  },
  15_000,
);

test.each(["standard", "codemode"] as const)(
  "%s explains off-Space screenshot omissions to the model while retaining menu controls",
  async (mode) => {
    const layout = {
      id: "window",
      revision: "one",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => ({
        layout,
        width: 1,
        height: 1,
        excludesChildWindows: true,
        image: {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
        },
      }),
      input: async () => {
        throw Error("Observation must not inject input");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async (target) => ({
          id: "one",
          app: target.app,
          windowTitle: "test",
          text: '[1] AXMenuItem AXTitle="Make Upper Case"',
        }),
        input: async () => {
          throw Error("Observation must not inject input");
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    f.provider.setResponses([
      mode === "codemode"
        ? script(
            'const r=await tools.computer({action:"screenshot",app:"TextEdit"});if(!r.ok)throw Error(r.error.message);text({frame:r.frame,notes:r.notes,accessibility:r.accessibility});image(r.image);',
          )
        : fauxAssistantMessage(
            fauxToolCall("computer", { action: "screenshot", app: "TextEdit" }),
            { stopReason: "toolUse" },
          ),
      (context) => {
        const result = context.messages.at(-1)!;
        expect(result.role).toBe("toolResult");
        const content = result.role === "toolResult" ? result.content : [];
        expect(content.some((part) => part.type === "image")).toBe(true);
        const text = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        expect(text).toContain('"excludesChildWindows":true');
        expect(text).toContain("image excludes menus and child windows");
        expect(text).toContain("Make Upper Case");
        return fauxAssistantMessage("Use the menu's accessibility index");
      },
    ]);
    await f.run();
  },
);

test.each(["standard", "codemode"] as const)(
  "%s recovers the drawing-session parameter mistakes and sends a continuous path as one input",
  async (mode) => {
    const inputs: ComputerInput[] = [];
    let captures = 0,
      frameId = "",
      snapshot = 0;
    const layout = {
      id: "window",
      revision: "one",
      bounds: { x: -100, y: 20, width: 100, height: 100 },
    };
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => {
        captures++;
        return {
          layout,
          width: 1,
          height: 1,
          image: {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
          },
        };
      },
      input: async () => {
        throw Error("No global input");
      },
      releaseInputs: async () => {},
      accessibility: {
        observe: async () => ({
          id: String(++snapshot),
          app: "com.google.Chrome",
          windowTitle: "canvas",
          text: "[0] AXPopUpButton actions=AXShowMenu",
        }),
        input: async (_state, input) => {
          inputs.push(input);
        },
        reset: async () => {},
      },
    });
    const f = await fixture({ agentMode: mode }, undefined, {
      computer: { service, enabled: () => true },
    });
    const call = (args: Record<string, JsonValue>) =>
      mode === "standard"
        ? fauxAssistantMessage(fauxToolCall("computer", args), { stopReason: "toolUse" })
        : script(
            `const r=await tools.computer(${JSON.stringify(args).replace('"FRAME"', 'load("drawing-frame")')});text(r);if(r.ok&&r.frame)store("drawing-frame",r.frame.id);`,
          );
    const result = (context: { messages: unknown[] }) => JSON.stringify(context.messages.at(-1));
    f.provider.setResponses([
      call({ action: "observe", screenshot: true }),
      (context) => {
        expect(result(context)).toContain("requires app");
        expect(result(context)).toContain("Google Chrome");
        expect(captures).toBe(0);
        return call({ action: "observe", app: "Google Chrome", screenshot: true });
      },
      (context) => {
        if (mode === "standard") {
          const last = context.messages.at(-1)!;
          if (last.role === "toolResult")
            frameId = JSON.parse(
              last.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(""),
            ).frame.id;
        }
        return call({
          action: "click",
          app: "TextEdit",
          frameId: mode === "standard" ? frameId : "FRAME",
          point: { x: 0, y: 0 },
        });
      },
      (context) => {
        expect(result(context)).toContain("does not match");
        expect(inputs).toHaveLength(0);
        return call({
          action: "click",
          app: "Google Chrome",
          windowTitle: "CANVAS",
          frameId: mode === "standard" ? frameId : "FRAME",
          point: { x: 0, y: 0 },
        });
      },
      (context) => {
        expect(inputs).toHaveLength(1);
        if (mode === "standard") {
          const last = context.messages.at(-1)!;
          if (last.role === "toolResult")
            frameId = JSON.parse(
              last.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(""),
            ).frame.id;
        }
        return call({
          action: "drag",
          frameId: mode === "standard" ? frameId : "FRAME",
          path: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: 0.8, y: 0.2 },
          ],
          durationMs: 450,
        });
      },
      () => fauxAssistantMessage("Path verified"),
    ]);
    await f.run();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({
      action: "drag",
      durationMs: 450,
      from: { x: -100, y: 20 },
      to: { x: -20, y: 40 },
      path: [
        { x: -100, y: 20 },
        { x: -50, y: 70 },
        { x: -20, y: 40 },
      ],
    });
    expect(captures).toBe(3);
  },
  30000,
);

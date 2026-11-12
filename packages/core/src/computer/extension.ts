import { defineTool, ROOT_CONVERSATION_ID, section } from "@eta/agent";
import type { Extension, ToolExecutionApi, ToolExecutionResult } from "@eta/agent";
import type { Context } from "@earendil-works/chord";
import type { ComputerService, ComputerOwner } from "@eta/computer-use/service";
import { ComputerError } from "@eta/computer-use/protocol";
import type { ComputerInput } from "@eta/computer-use/protocol";
import { computerParameters, computerResult } from "./schema.ts";
import { computerImageDigest } from "./images.ts";

// The tool schema validates field types; this table owns per-action field requirements.
const targetHints = ["app", "windowTitle"];
const actions: Record<string, { required: string[]; optional: string[] }> = {
  observe: {
    required: ["app"],
    optional: ["windowTitle", "screenshot", "surface", "projection", "frameId", "rootIndex"],
  },
  screenshot: { required: [], optional: ["app", "windowTitle", "surface"] },
  release: { required: [], optional: [] },
  wait: { required: [], optional: ["durationMs", "frameId", "condition", "timeoutMs"] },
  open: { required: ["app"], optional: [] },
  click: {
    required: ["frameId"],
    optional: [...targetHints, "point", "elementIndex", "button", "count"],
  },
  type: {
    required: ["frameId", "text"],
    optional: [...targetHints, "point", "elementIndex", "overwrite", "enter"],
  },
  key: { required: ["frameId", "keys"], optional: targetHints },
  scroll: {
    required: ["frameId"],
    optional: [...targetHints, "point", "elementIndex", "deltaX", "deltaY"],
  },
  drag: { required: ["frameId"], optional: [...targetHints, "point", "to", "path", "durationMs"] },
  set_value: { required: ["frameId", "elementIndex", "text"], optional: targetHints },
  select_text: {
    required: ["frameId", "elementIndex", "text"],
    optional: [...targetHints, "prefix", "suffix", "selectionType"],
  },
  perform_action: { required: ["frameId", "elementIndex", "name"], optional: targetHints },
  set_checked: { required: ["frameId", "elementIndex", "state"], optional: targetHints },
  set_expanded: { required: ["frameId", "elementIndex", "state"], optional: targetHints },
  select: { required: ["frameId", "elementIndex", "name"], optional: targetHints },
};

export function createComputerExtension(options: {
  service: ComputerService;
  owner(api: ToolExecutionApi, context: Context): Promise<ComputerOwner>;
  allowed(): Promise<boolean>;
}): Extension {
  const tool = defineTool({
    name: "computer",
    description: [
      "Observe and operate a selected local app without moving the system cursor or activating it. Prefer observe(app,windowTitle?) for an accessibility tree; choose elementIndex from that tree. observe(screenshot:true) or screenshot returns a target-window image when visual context is needed; screenshot may omit app after a target is selected. Coordinates are pixels in that image.",
      "For menu-bar apps use observe({app,surface:'menu_bar'}) and click the numbered status item to open its menu or popover. Opening a status menu can display a panel on the current desktop. ",
      "Input requires the latest result.frame.id. Every input refreshes the tree; unchanged indexed lines may be omitted from updates. Explicit observe returns the full tree. Never reuse removed indexes or earlier frames. AX click uses AXPress or a validated element-center click when AXPress is absent; failed AX actions are not automatically retried.",
      "observe projection defaults to full. If a large tree is clipped, use projection:'overview'. If the target region is still hidden, expand a numbered projection boundary with observe({app,frameId,rootIndex,projection:'overview'}) until the region is named. Expand the named region with projection:'compact'. Every drill-down returns a new frame.id, including when it is AX-only. In Code mode print that ID together with the returned indexes and observation boundaries before using them. An incomplete read cannot prove absence. Region input refreshes that region, with an explicit original-window fallback if the region disappears or opens a menu. Screenshots keep window coordinates.",
      "wait({frameId,condition,timeoutMs?}) polls the selected window or region and returns its final AX state when available. Conditions are {kind:'present'|'absent',text,role?} for exact AX title, description or value, or {kind:'enabled'|'value',elementIndex,equals} for one control from that frame. Inspect wait.status before continuing. A closed target, ambiguous match, timeout or changed final state does not confirm the condition. Use durationMs by itself for a fixed delay.",
      "set_value replaces an editable value. type simulates text and optionally focuses elementIndex/point, overwrites, and presses Enter. For drag, locate the object and destination in the app pixels. The drawn agent cursor marks the last action coordinates. Send the whole gesture as one point/to or path:[{x,y},...] call, then inspect the returned image before deciding whether to move the object again. durationMs controls the entire drag. Chain only already-decided steps with each preceding frame.id.",
      "For a supported checkbox, radio selection or disclosure control use set_checked or set_expanded with frameId, elementIndex and the desired boolean state. Read verification.status and applied. An already-satisfied control returns verification.noOp:true and applied:no. If delivery or readback is uncertain, observe the current state before deciding the next action.",
      "select uses the container's elementIndex and exact option name. For a dropdown, open it and observe its own options first. A duplicate name is rejected. Verify the selected value or row in the returned result before continuing.",
      "Background input support varies by app. Check the returned state to confirm the effect. Post-input screenshots settle for a bounded interval; quiet pixels do not prove loading or sending finished. On error inspect applied before retrying input or sending.",
      "Code mode: const r=await tools.computer({action:'observe',app:'TextEdit'});if(!r.ok)throw Error(r.error.message);text({frame:r.frame,accessibility:r.accessibility,observation:r.observation,verification:r.verification,applied:r.applied,notes:r.notes});if(r.image)image(r.image); End the script to inspect the result before choosing unknown targets. Output images with image(r.image), never print base64.",
      "open(app) launches an app in the background without a frameId and returns its running-instance selector in app. Observe that returned app before input; launch success does not prove a window is ready. release relinquishes control.",
    ].join(" "),
    parameters: computerParameters,
    structuredOutputSchema: computerResult,
    replay: "unsafe",
    executionMode: "sequential",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      try {
        const { required, optional } = actions[args.action]!;
        const allowed = [...required, ...optional];
        const unexpected = Object.keys(args).filter(
          (key) => key !== "action" && !allowed.includes(key),
        );
        if (unexpected.length)
          throw new ComputerError(
            "invalid_input",
            `${args.action} does not accept: ${unexpected.join(", ")}. Allowed fields: ${allowed.join(", ")}.`,
          );
        const missing = required.filter((field) => !Object.hasOwn(args, field));
        if (missing.length)
          throw new ComputerError(
            "invalid_input",
            missing.includes("app")
              ? `${args.action} requires app. Choose the intended application explicitly, e.g. {action:"${args.action}",app:"Google Chrome"${args.action === "observe" ? ",screenshot:true" : ""}}. This call did not select an application or send input.`
              : `${args.action} requires ${missing.join(", ")}. Use the latest result.frame.id; prior completed actions are not undone.`,
          );
        if (
          args.action === "drag" &&
          (args.path ? Boolean(args.point || args.to) : !args.point || !args.to)
        )
          throw new ComputerError(
            "invalid_input",
            "drag requires either path (2–256 points including start/end) or point and to; do not combine them",
          );
        if (args.action === "screenshot" && (args.windowTitle || args.surface) && !args.app)
          throw new ComputerError("invalid_input", "screenshot(windowTitle/surface) requires app");
        if (args.surface && args.windowTitle)
          throw new ComputerError(
            "invalid_input",
            "surface:menu_bar cannot be combined with windowTitle",
          );
        if (
          args.action === "observe" &&
          ((args.frameId !== undefined) !== (args.rootIndex !== undefined) ||
            (args.rootIndex !== undefined && args.surface))
        )
          throw new ComputerError(
            "invalid_input",
            "Region observe requires frameId and rootIndex together, without surface",
          );
        if (args.point && args.elementIndex !== undefined)
          throw new ComputerError(
            "invalid_input",
            "Specify either point or elementIndex, not both",
          );
        if (
          (args.action === "click" || args.action === "scroll") &&
          !args.point &&
          args.elementIndex === undefined
        )
          throw new ComputerError("invalid_input", `${args.action} requires point or elementIndex`);
        if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("仅主 agent 可以操作桌面");
        if (
          args.action === "wait" &&
          (args.condition
            ? !args.frameId || args.durationMs !== undefined
            : args.frameId !== undefined || args.timeoutMs !== undefined)
        )
          throw new ComputerError(
            "invalid_input",
            "Conditional wait requires frameId and condition. Use durationMs only for a fixed delay.",
          );
        const owner = await options.owner(api, context);
        if (args.action === "release") {
          await options.service.release(owner);
          return {
            structuredOutput: { ok: true, notes: ["Desktop control released."] },
            output: [{ type: "text", text: "Desktop control released." }],
          };
        }
        if (!(await options.allowed())) throw new Error("桌面控制未开启，或图片已被禁止");
        const agent = await api.agent(context);
        const model = agent.model && api.models.getModel(agent.model.provider, agent.model.modelId);
        if (!model?.input.includes("image")) throw new Error("当前模型不支持图片，不能操作桌面");
        const limits = model.inputLimits?.images?.resize;
        if (model.inputLimits?.images?.maxPerMessage === 0) throw new Error("当前模型不允许图片");
        const signal = AbortSignal.any([
          ...(context.abortSignal ? [context.abortSignal] : []),
          AbortSignal.timeout(30000),
        ]);
        if (args.action === "open") {
          const application = await options.service.open(owner, args.app!, signal);
          const notes = [
            application
              ? "Application launched in the background. Use observe with the returned app selector (not the launch name) before input; launch completion does not prove a window is ready."
              : "Application launch requested. Use observe(app) before input; launch completion does not prove the UI is ready.",
          ];
          return {
            structuredOutput: { ok: true, ...application, notes },
            output: [{ type: "text", text: JSON.stringify({ ...application, notes }) }],
          };
        }
        let result;
        if (args.action === "observe")
          result = await options.service.observe(
            owner,
            {
              app: args.app!,
              ...(args.windowTitle === undefined ? {} : { windowTitle: args.windowTitle }),
              ...(args.surface === undefined ? {} : { surface: args.surface }),
              ...(args.projection === undefined ? {} : { projection: args.projection }),
              ...(args.frameId === undefined ? {} : { frameId: args.frameId }),
              ...(args.rootIndex === undefined ? {} : { rootIndex: args.rootIndex }),
            },
            signal,
            limits,
            args.screenshot,
          );
        else if (args.action === "screenshot")
          result = await options.service.screenshot(
            owner,
            signal,
            limits,
            args.app
              ? {
                  app: args.app,
                  ...(args.windowTitle === undefined ? {} : { windowTitle: args.windowTitle }),
                  ...(args.surface === undefined ? {} : { surface: args.surface }),
                }
              : undefined,
          );
        else if (args.action === "wait")
          result = args.condition
            ? await options.service.waitUntil(
                owner,
                args.frameId!,
                args.condition,
                args.timeoutMs ?? 5000,
                signal,
              )
            : await options.service.wait(owner, args.durationMs ?? 500, signal, limits);
        else {
          const element =
            args.elementIndex === undefined ? {} : { elementIndex: args.elementIndex };
          const point = args.point ? { point: args.point } : {};
          let input: Exclude<ComputerInput, { action: "open" }>;
          switch (args.action) {
            case "click":
              input = {
                action: "click",
                ...point,
                ...element,
                button: args.button ?? "left",
                count: args.count ?? 1,
              };
              break;
            case "type":
              input = {
                action: "type",
                text: args.text!,
                ...point,
                ...element,
                overwrite: args.overwrite,
                enter: args.enter,
              };
              break;
            case "key":
              input = { action: "key", keys: args.keys! };
              break;
            case "scroll":
              input = {
                action: "scroll",
                ...point,
                ...element,
                deltaX: args.deltaX ?? 0,
                deltaY: args.deltaY ?? 0,
              };
              break;
            case "drag":
              input = {
                action: "drag",
                from: args.path?.[0] ?? args.point!,
                to: args.path?.at(-1) ?? args.to!,
                ...(args.path ? { path: args.path } : {}),
                ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
              };
              break;
            case "set_value":
              input = { action: "set_value", elementIndex: args.elementIndex!, text: args.text! };
              break;
            case "select_text":
              input = {
                action: "select_text",
                elementIndex: args.elementIndex!,
                text: args.text!,
                prefix: args.prefix,
                suffix: args.suffix,
                selectionType: args.selectionType,
              };
              break;
            case "perform_action":
            case "select":
              input = {
                action: args.action,
                elementIndex: args.elementIndex!,
                name: args.name!,
              };
              break;
            case "set_checked":
            case "set_expanded":
              input = { action: args.action, elementIndex: args.elementIndex!, state: args.state! };
              break;
            default:
              throw new ComputerError("invalid_input", "未知桌面动作");
          }
          result = await options.service.input(owner, args.frameId!, input, signal, limits, {
            app: args.app,
            windowTitle: args.windowTitle,
          });
        }
        const notes = [
          ...(result.frame
            ? [
                "Element indexes belong to this frame only. Read the returned state before deciding the next target.",
              ]
            : ["No actionable frame was returned. Observe the intended target before input."]),
          ...(result.frame?.excludesChildWindows
            ? [
                "The target is on another Space. This image excludes menus and child windows; use their numbered accessibility controls. Their absence from this image does not mean they are closed.",
              ]
            : []),
          ...("image" in result && result.image
            ? [
                "Coordinates are pixels in the returned target-window image. The drawn agent cursor is independent of the system cursor.",
              ]
            : [
                "No screenshot is included in this result. Use observe(screenshot:true) or screenshot when visual context is needed.",
              ]),
        ];
        const image = "image" in result ? result.image : undefined;
        const metadata = {
          ...(result.frame ? { frame: result.frame } : {}),
          ...("wait" in result ? { wait: result.wait } : {}),
          ...("accessibility" in result
            ? {
                accessibility: result.accessibility,
                app: result.app,
                windowTitle: result.windowTitle,
                ...("observation" in result ? { observation: result.observation } : {}),
              }
            : {}),
          notes,
          ...("applied" in result && result.applied
            ? { applied: result.applied, verification: result.verification }
            : {}),
        };
        return {
          ...(image ? { details: { computerImages: [computerImageDigest(image)] } } : {}),
          structuredOutput: { ok: true, ...metadata, ...(image ? { image: { ...image } } : {}) },
          output: [{ type: "text", text: JSON.stringify(metadata) }, ...(image ? [image] : [])],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof ComputerError ? error.code : "unavailable";
        const applied = error instanceof ComputerError ? error.applied : "no";
        const recovery =
          code === "user_interrupted"
            ? "The user explicitly stopped desktop control. Stop computer-use for this task and wait for a new user instruction. Do not retry, re-observe, reopen, or release-and-reacquire control."
            : code === "stale_frame" || applied !== "no"
              ? "The interface or input target changed. Observe the target again and continue from its current state. Do not blindly replay an input with applied=yes or unknown."
              : undefined;
        const failure = {
          ok: false,
          error: { code, message },
          applied,
          verification: (error instanceof ComputerError ? error.verification : undefined) ?? {
            status: applied === "no" ? "unverified" : "unknown",
          },
          ...(recovery ? { recovery } : {}),
        };
        return {
          isError: true,
          structuredOutput: failure,
          output: [{ type: "text", text: JSON.stringify(failure) }],
        };
      }
    },
  });
  return {
    name: "computer",
    tools: [tool],
    sections: [
      section("computer-use", async ({ conversationId }) =>
        conversationId === ROOT_CONVERSATION_ID && (await options.allowed())
          ? [
              "The computer tool is available for local desktop UI, including existing browser windows. Native browser UI control requires no browser connector or browser skill.",
              "Menu-bar status apps: computer({action:'observe',app:'APP',surface:'menu_bar'}) selects only that app's icon. Click its numbered item to open the menu or popover on the current desktop, then inspect the returned state. A visible popover can also be observed directly by app.",
              "Start with computer({action:'observe',app:'APP'}); add windowTitle only to select a specific window. A unique partial title is accepted. Use the returned frame.id and numbered controls for input. Every input already returns an updated accessibility tree: inspect it before choosing the next target. Chain only already-decided steps with each preceding frame.id. If that state proves the task is complete, report the result; request a screenshot only when visual evidence is needed.",
              "After open(app), use its returned app selector for observe rather than guessing the running name. Launch success is not window readiness.",
              "Common inputs: {action:'click',frameId,elementIndex}, {action:'set_value',frameId,elementIndex,text}, or {action:'drag',frameId,point:{x,y},to:{x,y}}. A frame already selects the app/window; optional target hints only validate that selection.",
              "For a clipped tree, start with overview and expand its numbered projection boundaries in overview until you see the named region. Then use compact on that region. After every expansion, print the new frame.id with the new indexes and boundaries. Use the new frame even when there is no screenshot. Check observation.scope, boundaries and unknown before inferring absence. Explicit full observe recovers the whole window.",
              "Use wait({frameId,condition,timeoutMs?}) for asynchronous UI changes. Continue when wait.status is 'satisfied' and use the returned frame for the next action. Timeout, ambiguous evidence and target closure are separate outcomes.",
              "Use set_checked and set_expanded with the latest frameId, elementIndex and desired state. Check applied and verification before deciding whether further input is needed.",
              "To select an option, use select with the container elementIndex and exact name. Open dropdowns first and inspect their associated options. Check the returned verification.",
              "In Code mode, tools.computer is already callable; no ALL_TOOLS search or schema-discovery call is needed. First call: const r=await tools.computer({action:'observe',app:'APP'});text(r); For screenshots, first check r.ok; on failure print r and stop before choosing input. On success output text({frame:r.frame,accessibility:r.accessibility,observation:r.observation,verification:r.verification,applied:r.applied,notes:r.notes});if(r.image)image(r.image); never print image base64. End the script to inspect unknown targets before input.",
            ].join("\n")
          : undefined,
      ),
    ],
  };
}

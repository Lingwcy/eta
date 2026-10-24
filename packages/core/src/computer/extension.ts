import { defineTool, ROOT_CONVERSATION_ID } from "@eta/agent";
import type { ToolExecutionApi, ToolExecutionResult } from "@eta/agent";
import type { Context } from "@earendil-works/chord";
import type { ComputerService, ComputerOwner } from "@eta/computer-use/service";
import { ComputerError } from "@eta/computer-use/protocol";
import type { ComputerInput } from "@eta/computer-use/protocol";
import { computerParameters, computerResult } from "./schema.ts";
import { computerImageDigest } from "./images.ts";

// The tool schema validates field types; this table owns per-action field requirements.
const actions: Record<string, { required: string[]; optional: string[] }> = {
  observe: { required: ["app"], optional: ["windowTitle", "screenshot"] },
  screenshot: { required: [], optional: ["app", "windowTitle"] },
  release: { required: [], optional: [] },
  wait: { required: [], optional: ["durationMs"] },
  open: { required: ["app"], optional: [] },
  click: { required: ["frameId"], optional: ["app", "point", "elementIndex", "button", "count"] },
  type: {
    required: ["frameId", "text"],
    optional: ["app", "point", "elementIndex", "overwrite", "enter"],
  },
  key: { required: ["frameId", "keys"], optional: ["app"] },
  scroll: { required: ["frameId"], optional: ["app", "point", "elementIndex", "deltaX", "deltaY"] },
  drag: { required: ["frameId"], optional: ["app", "point", "to", "path", "durationMs"] },
  set_value: { required: ["frameId", "elementIndex", "text"], optional: ["app"] },
  select_text: {
    required: ["frameId", "elementIndex", "text"],
    optional: ["app", "prefix", "suffix", "selectionType"],
  },
  perform_action: { required: ["frameId", "elementIndex", "name"], optional: ["app"] },
};

/** The runtime supplies an admission-bound owner; native element identities never enter durable replay. */
export function createComputerExtension(options: {
  service: ComputerService;
  owner(api: ToolExecutionApi, context: Context): Promise<ComputerOwner>;
  allowed(): Promise<boolean>;
}) {
  const tool = defineTool({
    name: "computer",
    description: [
      "Observe and operate a selected local app without moving the system cursor or activating it. Prefer observe(app,windowTitle?) for an accessibility tree; choose elementIndex from that tree. observe(screenshot:true) or screenshot returns a target-window image when visual context is needed; screenshot may omit app after a target is selected. Coordinates are pixels in that image.",
      "Input requires the latest result.frame.id. Every input refreshes the tree; unchanged indexed lines may be omitted from updates. Explicit observe returns the full tree. Never reuse removed indexes or earlier frames. AX click uses AXPress or a validated element-center click when AXPress is absent; failed AX actions are not automatically retried.",
      "set_value replaces an editable value. type simulates text and optionally focuses elementIndex/point, overwrites, and presses Enter. drag takes point/to or path:[{x,y},...] for one continuous stroke; prefer path over loops of short drags for an already-decided route. durationMs controls the entire drag. Observe before choosing unknown targets; chain only already-decided steps with each preceding frame.id.",
      "Background input support varies by app. Check the returned state to confirm the effect. Post-input screenshots settle for a bounded interval; quiet pixels do not prove loading or sending finished. On error inspect applied before retrying input or sending.",
      "Code mode: const r=await tools.computer({action:'observe',app:'TextEdit'});if(!r.ok)throw Error(r.error.message);text({frame:r.frame,accessibility:r.accessibility,notes:r.notes});if(r.image)image(r.image); End the script to inspect the result before choosing unknown targets. Output images with image(r.image), never print base64.",
      "open(app) launches an app in the background without a frameId; observe it before input. release relinquishes control.",
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
        if (args.action === "screenshot" && args.windowTitle && !args.app)
          throw new ComputerError("invalid_input", "screenshot(windowTitle) requires app");
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
          await options.service.open(owner, args.app!, signal);
          const notes = [
            "Application launched in the background. Use observe(app) to inspect its current window before input; launch completion does not prove the UI is ready.",
          ];
          return {
            structuredOutput: { ok: true, notes },
            output: [{ type: "text", text: notes[0]! }],
          };
        }
        let result;
        if (args.action === "observe")
          result = await options.service.observe(
            owner,
            {
              app: args.app!,
              ...(args.windowTitle === undefined ? {} : { windowTitle: args.windowTitle }),
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
                }
              : undefined,
          );
        else if (args.action === "wait")
          result = await options.service.wait(owner, args.durationMs ?? 500, signal, limits);
        else {
          const element =
            args.elementIndex === undefined ? {} : { elementIndex: args.elementIndex };
          const point = args.point ? { point: args.point } : {};
          let input: ComputerInput;
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
              input = {
                action: "perform_action",
                elementIndex: args.elementIndex!,
                name: args.name!,
              };
              break;
            default:
              throw new ComputerError("invalid_input", "未知桌面动作");
          }
          result = await options.service.input(
            owner,
            args.frameId!,
            input,
            signal,
            limits,
            args.app,
          );
        }
        const notes = [
          "Element indexes belong to this frame only. Read the returned state before deciding the next target.",
          ...(result.frame.excludesChildWindows
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
          frame: result.frame,
          ...("accessibility" in result
            ? {
                accessibility: result.accessibility,
                app: result.app,
                windowTitle: result.windowTitle,
              }
            : {}),
          notes,
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
            ? "The user took over the target app. Stop computer-use for this task and wait for a new user instruction. Do not retry, re-observe, reopen, or release-and-reacquire control."
            : undefined;
        const failure = {
          ok: false,
          error: { code, message },
          applied,
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
  return { name: "computer", tools: [tool] };
}

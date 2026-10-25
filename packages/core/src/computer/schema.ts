import { Type } from "@earendil-works/pi-ai";

const Point = Type.Object({ x: Type.Number(), y: Type.Number() });
const Image = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});
const Frame = Type.Object({
  id: Type.String(),
  excludesChildWindows: Type.Optional(Type.Boolean()),
  displayId: Type.String(),
  imageWidth: Type.Number(),
  imageHeight: Type.Number(),
  capturedAt: Type.Number(),
  observation: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("deadline")])),
});
export const computerResult = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    frame: Type.Optional(Frame),
    image: Type.Optional(Image),
    accessibility: Type.Optional(Type.String()),
    app: Type.Optional(Type.String()),
    windowTitle: Type.Optional(Type.String()),
    notes: Type.Array(Type.String()),
  }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({ code: Type.String(), message: Type.String() }),
    applied: Type.Union([Type.Literal("no"), Type.Literal("yes"), Type.Literal("unknown")]),
  }),
]);
export const computerParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("observe"),
      Type.Literal("screenshot"),
      Type.Literal("wait"),
      Type.Literal("release"),
      Type.Literal("click"),
      Type.Literal("type"),
      Type.Literal("key"),
      Type.Literal("scroll"),
      Type.Literal("drag"),
      Type.Literal("open"),
      Type.Literal("set_value"),
      Type.Literal("select_text"),
      Type.Literal("perform_action"),
    ]),
    frameId: Type.Optional(
      Type.String({
        description:
          "REQUIRED for click/type/key/scroll/drag/set_value/select_text/perform_action. Use the latest result.frame.id; all element indexes expire after input or a new observation.",
      }),
    ),
    app: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "REQUIRED for observe/open; screenshot may omit app only after selecting a target. Application name or bundle identifier, e.g. TextEdit or com.apple.TextEdit. observe/screenshot also accept a unique case-insensitive application-name substring or pid:123 to select one running instance. open launches an app name or bundle identifier in the background; it does not accept pid selectors. On input actions, an optional app hint must match the already-observed app; it never retargets a frame.",
      }),
    ),
    windowTitle: Type.Optional(
      Type.String({
        maxLength: 512,
        description:
          "observe/screenshot: exact title or a unique case-insensitive substring. Exact matches take priority; ambiguous titles are rejected with candidate titles. Omit to use the app's focused window. On input, an optional title hint must match the observed window; it never retargets a frame.",
      }),
    ),
    surface: Type.Optional(
      Type.Literal("menu_bar", {
        description:
          "observe/screenshot: select this app's menu-bar status icon, even when it has no window. Click its numbered item to open the menu or popover; subsequent input returns the opened panel. Omit for normal windows.",
      }),
    ),
    screenshot: Type.Optional(
      Type.Boolean({
        description:
          "observe: include a target-window screenshot when AX text is insufficient; default false. Coordinates are pixels in that window image.",
      }),
    ),
    elementIndex: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 799,
        description:
          "Index from the latest accessibility tree, bound to frameId. Prefer this over point.",
      }),
    ),
    point: Type.Optional(Point),
    to: Type.Optional(Point),
    path: Type.Optional(
      Type.Array(Point, {
        minItems: 2,
        maxItems: 256,
        description:
          "drag: one continuous stroke in screenshot pixels, including start/end. Use path instead of point/to for an already-decided polyline; the mouse stays down until its end and only the final state is observed.",
      }),
    ),
    text: Type.Optional(Type.String({ maxLength: 16000 })),
    keys: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Case-insensitive chord: Enter/ENTER, Escape, Tab, ArrowLeft, command/cmd, control/ctrl, shift, option/alt. Modifiers may appear anywhere in the array; all modifiers are held before the other keys.",
        }),
        { minItems: 1, maxItems: 8 },
      ),
    ),
    overwrite: Type.Optional(Type.Boolean()),
    enter: Type.Optional(Type.Boolean()),
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
    count: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
    deltaX: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
    deltaY: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
    durationMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10000,
        description:
          "wait: delay; drag: desired total stroke duration (default follows route length). Native validation can add overhead.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        maxLength: 128,
        description:
          "perform_action: exact action exposed by the current element, e.g. AXShowMenu. Never invent action names.",
      }),
    ),
    prefix: Type.Optional(Type.String({ maxLength: 2000 })),
    suffix: Type.Optional(Type.String({ maxLength: 2000 })),
    selectionType: Type.Optional(
      Type.Union([
        Type.Literal("text"),
        Type.Literal("cursor_before"),
        Type.Literal("cursor_after"),
      ]),
    ),
  },
  { additionalProperties: false },
);

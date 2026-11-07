import { Type } from "@earendil-works/pi-ai";

const Point = Type.Object({ x: Type.Number(), y: Type.Number() });

/**
 * 图片数据
 */
const Image = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(), // base64 编码
  mimeType: Type.String(),
});

/**
 * 观察帧（frame）是工具在一次观察中生成的、绑定目标应用和窗口的操作上下文标识符；
 * 它通过帧 ID 标识，并确定本次观察所得元素索引的有效范围。
 * 输入操作或新的观察(action)发生后，原有元素索引失效，需要使用最新观察帧中的索引。
 */
const Frame = Type.Object({
  id: Type.String(),
  excludesChildWindows: Type.Optional(Type.Boolean()), // 是否排除子窗口
  displayId: Type.String(), // 目标所在显示器标识
  imageWidth: Type.Number(), // 画面宽度
  imageHeight: Type.Number(), // 画面高度
  capturedAt: Type.Number(), // 采集时间
  // 界面是否稳定
  observation: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("deadline")])),
});

/**
 * computer-use 工具返回定义
 */
export const computerResult = Type.Union([
  // 成功结构
  Type.Object({
    ok: Type.Literal(true),
    frame: Type.Optional(Frame), // 可选的观察帧
    image: Type.Optional(Image), // 可选的截图数据
    accessibility: Type.Optional(Type.String()), // 可选的无障碍控件树
    app: Type.Optional(Type.String()), // 可选的目标应用
    windowTitle: Type.Optional(Type.String()), // 可选的窗口标题
    notes: Type.Array(Type.String()), // 提供的附加信息
  }),
  // 失败结构
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({ code: Type.String(), message: Type.String() }),
    // 是否实际应用到目标
    applied: Type.Union([Type.Literal("no"), Type.Literal("yes"), Type.Literal("unknown")]),
  }),
]);

/**
 * computer-use 工具输入定义
 */
export const computerParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("observe"), // 默认拿取 ax 控件树，按需带 screenshoot
      Type.Literal("screenshot"), // 获取目标窗口截图
      Type.Literal("wait"), // 等待指定时间
      Type.Literal("release"), // 释放当前持有的输入状态
      Type.Literal("click"), // 点击元素或者坐标
      Type.Literal("type"), // 输入文本
      Type.Literal("key"), // 按下按键或者组合按键
      Type.Literal("scroll"), // 滚动
      Type.Literal("drag"), // 拖拽或者绘制一条路径
      Type.Literal("open"), // 在后台启动应用
      Type.Literal("set_value"), // 设置元素的值
      Type.Literal("select_text"), // 选择文本或者定位光标
      Type.Literal("perform_action"), // 执行元素暴露的无障碍操作
    ]),
    frameId: Type.Optional(
      Type.String({
        description:
          "REQUIRED for click/type/key/scroll/drag/set_value/select_text/perform_action. Use the latest result.frame.id; all element indexes expire after input or a new observation.",
      }),
    ),
    // 应用名称或 bundle identifier
    app: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "REQUIRED for observe/open; screenshot may omit app only after selecting a target. Application name or bundle identifier, e.g. TextEdit or com.apple.TextEdit. observe/screenshot also accept a unique case-insensitive application-name substring or pid:123 to select one running instance. open launches an app name or bundle identifier in the background; it does not accept pid selectors. On input actions, an optional app hint must match the already-observed app; it never retargets a frame.",
      }),
    ),
    // 窗口标题
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
    // 是否截图
    screenshot: Type.Optional(
      Type.Boolean({
        description:
          "observe: include a target-window screenshot when AX text is insufficient; default false. Coordinates are pixels in that window image.",
      }),
    ),
    // 最新 AX 控件树中的元素索引，绑定到 frameId
    elementIndex: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 799,
        description:
          "Index from the latest accessibility tree, bound to frameId. Prefer this over point.",
      }),
    ),
    // 一个点
    point: Type.Optional(Point),
    // 终点
    to: Type.Optional(Point),
    // 拖拽路径轨迹
    path: Type.Optional(
      Type.Array(Point, {
        minItems: 2,
        maxItems: 256,
        description:
          "drag: one continuous stroke in screenshot pixels, including start/end. Use path instead of point/to for an already-decided polyline; the mouse stays down until its end and only the final state is observed.",
      }),
    ),
    // 操作使用的文本
    text: Type.Optional(Type.String({ maxLength: 16000 })),
    // 按键名称数组
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
    // 是否按下enter
    enter: Type.Optional(Type.Boolean()),
    // 鼠标左右键
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
    // 点击次数
    count: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
    deltaX: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
    deltaY: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
    // 持续时间 对于 wait 是等待时间；对于 drag 是期望的整条轨迹时长，省略时默认根据路径长度决定
    durationMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10000,
        description:
          "wait: delay; drag: desired total stroke duration (default follows route length). Native validation can add overhead.",
      }),
    ),
    // 执行无障碍操作的名称
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

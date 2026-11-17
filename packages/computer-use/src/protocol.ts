export type ComputerImage = { type: "image"; data: string; mimeType: string };

export type Point = { x: number; y: number };
export type ComputerProjection = "full" | "compact" | "overview";
export type ComputerObservation = {
  scope: "window" | "region" | "menu_bar";
  projection: ComputerProjection;
  /** Intended projection was read without unknown fields or accidental clipping. */
  complete: boolean;
  /** All descendants and the fields requested by this projection were read within the scope. */
  exhaustive: boolean;
  boundaries: { index: number; reason: string; omittedChildren?: number }[];
  unknown: { index: number; fields: string[] }[];
  visitedNodes: number;
  axReads: number;
  fallback?: "root_unavailable" | "menu_opened";
};
export type ComputerVerification = {
  status: "unverified" | "satisfied" | "unsatisfied" | "unknown";
  noOp?: boolean;
  reason?: string;
};
/** A running instance selected by launch; this is not a window observation. */
export type ComputerApplication = { app: string };

export type ComputerInputReceipt = {
  applied: "no" | "yes";
  verification: ComputerVerification;
};
export type ComputerCondition =
  | { kind: "present" | "absent"; text: string; role?: string }
  | { kind: "enabled"; elementIndex: number; equals: boolean }
  | { kind: "value"; elementIndex: number; equals: string };

export type ComputerWaitEvidence = "satisfied" | "unsatisfied" | "unknown" | "ambiguous";
export type ComputerWaitOutcome = {
  status: "satisfied" | "timeout" | "unconfirmed" | "ambiguous" | "target_closed";
  last: ComputerWaitEvidence;
  lastKnown?: ComputerWaitEvidence;
  final?: ComputerWaitEvidence;
  reason?: string;
  samples: number;
  probeReads: number;
};
export type ComputerResult = {
  frame: ComputerFrame;
  image?: ComputerImage;
  accessibility?: string;
  app?: string;
  windowTitle?: string;
  observation?: ComputerObservation;
  cursor?: Point;
  applied?: ComputerInputReceipt["applied"];
  verification?: ComputerVerification;
};
export type ComputerInput =
  | {
      action: "click";
      point?: Point;
      elementIndex?: number;
      button: "left" | "right";
      count: 1 | 2;
    }
  | {
      action: "type";
      text: string;
      point?: Point;
      elementIndex?: number;
      overwrite?: boolean;
      enter?: boolean;
    }
  | { action: "open"; app: string }
  | { action: "key"; keys: string[] }
  | { action: "scroll"; point?: Point; elementIndex?: number; deltaX: number; deltaY: number }
  | { action: "drag"; from: Point; to: Point; path?: Point[]; durationMs?: number }
  | { action: "set_value"; elementIndex: number; text: string }
  | {
      action: "select_text";
      elementIndex: number;
      text: string;
      prefix?: string;
      suffix?: string;
      selectionType?: "text" | "cursor_before" | "cursor_after";
    }
  | { action: "perform_action"; elementIndex: number; name: string }
  | { action: "select"; elementIndex: number; name: string }
  | { action: "set_checked" | "set_expanded"; elementIndex: number; state: boolean };

/** Element indexes belong only to this native observation, never to an app name or a later tree. */
export type ComputerAccessibility = {
  id: string;
  app: string;
  windowTitle: string;
  text: string;
  windowId?: number;
  bounds?: DisplayLayout["bounds"];
  cursor?: Point;
  observation?: ComputerObservation;
};

export type ComputerTarget = {
  app: string;
  windowTitle?: string;
  surface?: "menu_bar";
  previousId?: string;
  projection?: ComputerProjection;
  /** Public frame identity is resolved to previousId by ComputerService. */
  frameId?: string;
  rootIndex?: number;
  /** Internal post-input recovery, always pinned to the original window. */
  fallbackToWindow?: boolean;
};

export type DisplayLayout = {
  id: string;
  revision: string;
  bounds: { x: number; y: number; width: number; height: number };
};

export type CaptureLimits = {
  includeCursor?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
};

export type ComputerCapture = {
  image: ComputerImage;
  excludesChildWindows?: boolean;
  observation?: "stable" | "deadline";
  width: number;
  height: number;
  layout: DisplayLayout;
};

/** The host owns one adapter for one desktop session, shared across threads. */
export interface ComputerAdapter {
  layout(signal: AbortSignal, target?: ComputerAccessibility): Promise<DisplayLayout>;
  capture(
    signal: AbortSignal,
    limits?: CaptureLimits,
    afterInput?: boolean,
    target?: ComputerAccessibility,
  ): Promise<ComputerCapture>;
  input(input: ComputerInput, signal: AbortSignal): Promise<ComputerApplication | void>;
  /** Read takeover state before disposing the live native admission; never starts a new helper. */
  checkOwnership?(signal: AbortSignal): Promise<void>;
  accessibility?: {
    observe(target: ComputerTarget, signal: AbortSignal): Promise<ComputerAccessibility>;
    input(
      state: ComputerAccessibility,
      input: ComputerInput,
      signal: AbortSignal,
    ): Promise<ComputerInputReceipt | void>;
    waitUntil?(
      state: ComputerAccessibility,
      condition: ComputerCondition,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<{ outcome: ComputerWaitOutcome; state?: ComputerAccessibility }>;
    reset(): Promise<void>;
  };
  releaseInputs(): Promise<void>;
}

export type ComputerFrame = {
  id: string;
  excludesChildWindows?: boolean;
  displayId: string;
  imageWidth: number;
  imageHeight: number;
  capturedAt: number;
  observation?: "stable" | "deadline";
};

export class ComputerError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "stale_frame"
      | "invalid_frame"
      | "invalid_input"
      | "cancelled"
      | "user_interrupted"
      | "input_failed"
      | "observation_failed",
    message: string,
    readonly applied: "no" | "yes" | "unknown" = "no",
    readonly verification?: ComputerVerification,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

/** Convert pixels in the delivered image to the adapter's desktop coordinate space. */
export function desktopPoint(point: Point, capture: ComputerCapture): Point {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= capture.width ||
    point.y >= capture.height
  )
    throw new ComputerError("invalid_frame", "坐标超出截图范围，请重新观察");
  const { bounds } = capture.layout;
  return {
    x: bounds.x + (point.x * bounds.width) / capture.width,
    y: bounds.y + (point.y * bounds.height) / capture.height,
  };
}

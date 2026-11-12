import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerError } from "./protocol.ts";
import type {
  CaptureLimits,
  ComputerAdapter,
  ComputerCapture,
  ComputerFrame,
  ComputerInput,
  ComputerAccessibility,
  ComputerTarget,
  ComputerVerification,
  ComputerInputReceipt,
  ComputerResult,
  ComputerCondition,
  ComputerWaitOutcome,
} from "./protocol.ts";
import { mapComputerInput } from "./input.ts";
import { normalizeComputerKeys } from "./keys.ts";
import type { ComputerActivity, ComputerPointer } from "./presentation.ts";
import { accessibilityDiff } from "./accessibility.ts";

/** Identity is an instance per admitted run, never a reusable thread ID. */
export type ComputerOwner = { readonly active: () => boolean };
type TargetHint = { app?: string; windowTitle?: string };
type Lease = {
  id: string;
  presented?: ComputerAccessibility;
  appAliases?: { resolved: string; names: Set<string> };
  owner: ComputerOwner;
  controller: AbortController;
  frame?: { capture: ComputerCapture; frame: ComputerFrame };
  accessibility?: {
    state: ComputerAccessibility;
    frame: ComputerFrame;
    screenshot: boolean;
    surface?: "menu_bar";
  };
  pending?: Promise<unknown>;
  releasing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

/** Serializes observation and input across every conversation using the host's desktop. */
export class ComputerService {
  private lease?: Lease;
  private readonly stopped = new WeakSet<ComputerOwner>();

  constructor(
    private readonly adapter: ComputerAdapter,
    private readonly activity?: (event: ComputerActivity) => void,
  ) {}

  private publish(lease: Lease, event: ComputerActivity) {
    if (
      this.lease !== lease ||
      (event.type !== "end" && (lease.controller.signal.aborted || !lease.owner.active()))
    )
      return;
    this.activity?.(event);
  }

  /** The visible stop control revokes this admission, including re-observe/reacquire attempts. */
  stopPresentation(id: string) {
    const lease = this.lease;
    if (!lease || lease.id !== id) return Promise.resolve();
    this.stopped.add(lease.owner);
    return this.release(lease.owner);
  }

  presentPointer(pointer: ComputerPointer) {
    const lease = this.lease,
      target = lease?.presented;
    if (
      !lease ||
      !target ||
      target.id !== pointer.snapshot ||
      target.windowId !== pointer.windowId ||
      !target.bounds ||
      !(["x", "y", "width", "height"] as const).every(
        (key) => target.bounds![key] === pointer.bounds[key],
      )
    )
      return;
    this.publish(lease, { type: "pointer", id: lease.id, pointer });
  }

  private async present(
    lease: Lease,
    state: ComputerAccessibility,
    signal: AbortSignal,
    image?: ComputerCapture["image"],
  ) {
    if (!this.activity) return;
    lease.presented = state;
    this.publish(lease, { type: "target", id: lease.id, target: state });
    try {
      // A small host-only image also covers AX-only tool calls. It neither enters model
      // history nor replaces the frame/index map on which the next input was admitted.
      image ??= (
        await this.adapter.capture(
          signal,
          { maxWidth: 640, maxHeight: 480, maxBytes: 600_000, includeCursor: false },
          false,
          state,
        )
      ).image;
      this.check(lease, signal);
      this.publish(lease, { type: "frame", id: lease.id, image });
    } catch {
      // A preview failure does not replay an already-applied action. Cancellation still wins.
      this.check(lease, signal);
      this.publish(lease, { type: "unavailable", id: lease.id });
    }
  }

  async screenshot(
    owner: ComputerOwner,
    signal: AbortSignal,
    limits?: CaptureLimits,
    target?: ComputerTarget,
  ) {
    return this.operate(owner, signal, async (lease, current) => {
      const selected =
        target ??
        (lease.accessibility && {
          app: lease.accessibility.state.app,
          previousId: lease.accessibility.state.id,
          ...this.observationTarget(lease.accessibility.state),
          ...(lease.accessibility.surface ? { surface: lease.accessibility.surface } : {}),
        });
      return selected
        ? await this.observeApp(lease, selected, current, limits, true)
        : await this.capture(lease, current, limits);
    });
  }

  /** Opening an app needs no prior visual observation and does not capture unrelated desktop pixels. */
  async open(owner: ComputerOwner, app: string, signal: AbortSignal) {
    const input = this.appInput(app);
    return this.operate(owner, signal, async (lease, current) => {
      lease.frame = undefined;
      lease.accessibility = undefined;
      try {
        this.check(lease, current);
        const application = await this.adapter.input(input, current);
        this.check(lease, current);
        return application;
      } catch (error) {
        if (error instanceof ComputerError) throw error;
        throw new ComputerError(
          "input_failed",
          error instanceof Error ? error.message : String(error),
          "unknown",
        );
      }
    });
  }

  private appInput(app: string) {
    if (
      !app.trim() ||
      app.trim().startsWith("pid:") ||
      app.length > 256 ||
      ["\0", "\r", "\n"].some((character) => app.includes(character))
    )
      throw new ComputerError(
        "invalid_input",
        "open requires an application name, e.g. app:'TextEdit'",
      );
    return { action: "open" as const, app };
  }

  async wait(
    owner: ComputerOwner,
    durationMs: number,
    signal: AbortSignal,
    limits?: CaptureLimits,
    target?: TargetHint & { frameId?: string },
  ) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 10000)
      throw new ComputerError("invalid_frame", "等待时长必须在 0–10000ms 范围内");
    if (
      target &&
      (target.app !== undefined || target.windowTitle !== undefined) &&
      target.frameId === undefined
    )
      throw new ComputerError("invalid_input", "wait target hints require the latest frameId");
    return this.operate(owner, signal, async (lease, current) => {
      if (
        target?.frameId !== undefined &&
        target.frameId !== lease.accessibility?.frame.id &&
        target.frameId !== lease.frame?.frame.id
      )
        throw new ComputerError("stale_frame", "等待需要最新窗口观察");
      this.validateTargetHint(lease, target);
      await delay(durationMs, undefined, { signal: current });
      this.check(lease, current);
      return lease.accessibility
        ? this.observeApp(
            lease,
            {
              app: lease.accessibility.state.app,
              previousId: lease.accessibility.state.id,
              ...this.observationTarget(lease.accessibility.state),
              ...(lease.accessibility.surface ? { surface: lease.accessibility.surface } : {}),
            },
            current,
            limits,
            lease.accessibility.screenshot,
            lease.accessibility.state,
          )
        : this.capture(lease, current, limits);
    });
  }

  async waitUntil(
    owner: ComputerOwner,
    frameId: string,
    condition: ComputerCondition,
    timeoutMs: number,
    signal: AbortSignal,
    targetHint?: TargetHint,
  ): Promise<
    Partial<ComputerResult> & { wait: ComputerWaitOutcome & { condition: ComputerCondition } }
  > {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000)
      throw new ComputerError("invalid_input", "timeoutMs must be between 250 and 10000");
    const valid =
      "elementIndex" in condition
        ? Number.isSafeInteger(condition.elementIndex) &&
          condition.elementIndex >= 0 &&
          condition.elementIndex <= 799 &&
          (condition.kind === "enabled"
            ? typeof condition.equals === "boolean"
            : condition.kind === "value" &&
              typeof condition.equals === "string" &&
              condition.equals.length <= 1200)
        : (condition.kind === "present" || condition.kind === "absent") &&
          typeof condition.text === "string" &&
          condition.text.length > 0 &&
          condition.text.length <= 1200 &&
          (condition.role === undefined || /^AX[A-Za-z0-9]{1,126}$/.test(condition.role));
    if (!valid) throw new ComputerError("invalid_input", "Invalid wait condition");
    return this.operate(owner, signal, async (lease, current) => {
      const selected = lease.accessibility;
      if (!selected || selected.frame.id !== frameId)
        throw new ComputerError("stale_frame", "条件等待需要最新窗口观察");
      this.validateTargetHint(lease, targetHint);
      const accessibility = this.adapter.accessibility;
      if (selected.surface || !accessibility?.waitUntil)
        throw new ComputerError("invalid_input", "条件等待需要支持条件探测的窗口或区域");
      lease.frame = undefined;
      lease.accessibility = undefined;
      const { outcome, state } = await accessibility.waitUntil(
        selected.state,
        condition,
        timeoutMs,
        current,
      );
      this.check(lease, current);
      if (
        (outcome.status === "satisfied" && (!state || outcome.final !== "satisfied")) ||
        (state &&
          (state.id === selected.state.id ||
            state.app !== selected.state.app ||
            state.windowId !== selected.state.windowId ||
            state.observation?.scope !== selected.state.observation?.scope))
      )
        throw new ComputerError("observation_failed", "条件等待返回的观察与原窗口或区域不一致");
      const wait = { ...outcome, condition };
      if (!state) {
        if (outcome.status === "target_closed") {
          lease.presented = undefined;
          this.publish(lease, { type: "unavailable", id: lease.id });
        }
        return { wait };
      }
      const frame = {
        id: randomUUID(),
        displayId: "accessibility",
        imageWidth: 0,
        imageHeight: 0,
        capturedAt: Date.now(),
      };
      lease.accessibility = { state, frame, screenshot: false };
      const previousTarget = lease.presented;
      lease.presented = state;
      if (
        previousTarget?.windowTitle !== state.windowTitle ||
        JSON.stringify(previousTarget?.bounds) !== JSON.stringify(state.bounds)
      ) {
        this.publish(lease, { type: "target", id: lease.id, target: state });
        this.publish(lease, { type: "unavailable", id: lease.id });
      }
      return {
        wait,
        frame,
        accessibility: state.text,
        app: state.app,
        windowTitle: state.windowTitle,
        ...(state.observation ? { observation: state.observation } : {}),
      };
    });
  }

  private validateTargetHint(lease: Lease, targetHint?: TargetHint) {
    if (
      targetHint?.app !== undefined &&
      !lease.appAliases?.names.has(targetHint.app.trim().toLowerCase())
    )
      throw new ComputerError(
        "invalid_input",
        `app does not match the observed target; use observe(app:${JSON.stringify(targetHint.app)}) to select another application. This frame was not retargeted.`,
      );
    const accessibility = lease.accessibility;
    if (
      targetHint?.windowTitle !== undefined &&
      (!targetHint.windowTitle.trim() ||
        !accessibility?.state.windowTitle
          .toLowerCase()
          .includes(targetHint.windowTitle.toLowerCase()))
    )
      throw new ComputerError(
        "invalid_input",
        "windowTitle does not match the observed target; use observe(app,windowTitle) to select another window. This frame was not retargeted.",
      );
  }

  async input(
    owner: ComputerOwner,
    frameId: string,
    input: Exclude<ComputerInput, { action: "open" }>,
    signal: AbortSignal,
    limits?: CaptureLimits,
    targetHint?: TargetHint,
  ): Promise<ComputerResult> {
    const stateAction =
      input.action === "set_checked" ||
      input.action === "set_expanded" ||
      input.action === "select";
    if (
      input.action === "select" &&
      (!Number.isSafeInteger(input.elementIndex) ||
        input.elementIndex < 0 ||
        input.elementIndex > 799 ||
        typeof input.name !== "string" ||
        input.name.length === 0 ||
        input.name.length > 256)
    )
      throw new ComputerError(
        "invalid_input",
        "select requires an elementIndex and an exact option name",
      );
    if (
      (input.action === "set_checked" || input.action === "set_expanded") &&
      (typeof input.state !== "boolean" ||
        !Number.isSafeInteger(input.elementIndex) ||
        input.elementIndex < 0 ||
        input.elementIndex > 799)
    )
      throw new ComputerError(
        "invalid_input",
        "State actions require an elementIndex and a boolean state",
      );
    if (
      input.action === "drag" &&
      ((input.durationMs !== undefined &&
        (!Number.isSafeInteger(input.durationMs) ||
          input.durationMs < 0 ||
          input.durationMs > 10000)) ||
        (input.path && (input.path.length < 2 || input.path.length > 256)))
    )
      throw new ComputerError(
        "invalid_input",
        "drag requires 2–256 path points and durationMs between 0 and 10000",
      );
    if (input.action === "key") input = { ...input, keys: normalizeComputerKeys(input.keys) };
    let stateDelivery: Pick<ComputerError, "applied" | "verification"> | undefined;
    return this.operate<ComputerResult>(owner, signal, async (lease, current) => {
      this.validateTargetHint(lease, targetHint);
      const accessibility = lease.accessibility;
      if (accessibility?.frame.id === frameId) {
        if (stateAction && accessibility.surface)
          throw new ComputerError(
            "invalid_input",
            "State actions require a control in a window or region",
          );
        let mapped = input;
        if (("point" in input && input.point) || input.action === "drag") {
          const capture = lease.frame?.capture;
          if (!capture)
            throw new ComputerError(
              "invalid_input",
              "当前观察没有图片；请先 screenshot，再使用图片坐标",
            );
          const layout = await this.adapter.layout(current, accessibility.state);
          this.check(lease, current);
          if (JSON.stringify(layout) !== JSON.stringify(capture.layout))
            throw new ComputerError("stale_frame", "显示布局已变化，请重新观察");
          mapped = mapComputerInput(input, capture);
        }
        lease.frame = undefined;
        lease.accessibility = undefined;
        let receipt: ComputerInputReceipt | void;
        try {
          this.check(lease, current);
          receipt = await this.adapter.accessibility!.input(accessibility.state, mapped, current);
          if (stateAction && !receipt)
            throw new ComputerError("input_failed", "Missing state action receipt", "unknown");
          if (receipt) stateDelivery = receipt;
        } catch (error) {
          if (error instanceof ComputerError) {
            if (stateAction) stateDelivery = error;
            throw error;
          }
          throw new ComputerError(
            "input_failed",
            error instanceof Error ? error.message : String(error),
            "unknown",
          );
        }
        try {
          this.check(lease, current);
          const result = await this.observeApp(
            lease,
            {
              app: accessibility.state.app,
              previousId: accessibility.state.id,
              ...this.observationTarget(accessibility.state),
              ...(accessibility.state.observation?.scope === "region"
                ? { fallbackToWindow: true }
                : {}),
            },
            current,
            limits,
            input.action === "drag" || ("point" in input && input.point !== undefined),
            accessibility.state,
          );
          return {
            ...result,
            ...(receipt ?? { applied: "yes", verification: { status: "unverified" } }),
          };
        } catch (error) {
          throw new ComputerError(
            error instanceof ComputerError &&
              (error.code === "user_interrupted" || error.code === "stale_frame")
              ? error.code
              : "observation_failed",
            error instanceof Error ? error.message : String(error),
            receipt?.applied ?? "yes",
            receipt?.verification,
          );
        }
      }
      if ("elementIndex" in input)
        throw new ComputerError("stale_frame", "控件编号需要最新 observe 返回的 frameId");
      if ((input.action === "click" || input.action === "scroll") && !input.point)
        throw new ComputerError("invalid_input", "坐标操作需要 point");
      const observation = lease.frame;
      if (!observation || observation.frame.id !== frameId)
        throw new ComputerError("stale_frame", "观察已失效，请重新 observe 或 screenshot");
      const layout = await this.adapter.layout(current);
      this.check(lease, current);
      if (JSON.stringify(layout) !== JSON.stringify(observation.capture.layout)) {
        lease.frame = undefined;
        throw new ComputerError("stale_frame", "显示布局已变化，请重新截图");
      }
      const mapped = mapComputerInput(input, observation.capture);
      // Invalidate before injecting: a failed input may already have changed the desktop.
      lease.frame = undefined;
      lease.accessibility = undefined;
      this.check(lease, current);
      try {
        await this.adapter.input(mapped, current);
      } catch (error) {
        if (error instanceof ComputerError) throw error;
        throw new ComputerError(
          "input_failed",
          error instanceof Error ? error.message : String(error),
          "unknown",
        );
      }
      try {
        this.check(lease, current);
        return {
          ...(await this.capture(lease, current, limits, true)),
          applied: "yes" as const,
          verification: { status: "unverified" } satisfies ComputerVerification,
        };
      } catch (error) {
        throw new ComputerError(
          error instanceof ComputerError &&
            (error.code === "user_interrupted" || error.code === "stale_frame")
            ? error.code
            : "observation_failed",
          error instanceof Error ? error.message : String(error),
          "yes",
        );
      }
    }).catch((error: unknown) => {
      // Cleanup can supersede the operation error, but cannot change known delivery.
      if (
        !stateDelivery ||
        (error instanceof ComputerError &&
          error.applied === stateDelivery.applied &&
          error.verification === stateDelivery.verification)
      )
        throw error;
      throw new ComputerError(
        error instanceof ComputerError ? error.code : "input_failed",
        error instanceof Error ? error.message : String(error),
        stateDelivery.applied,
        stateDelivery.verification,
      );
    });
  }

  async observe(
    owner: ComputerOwner,
    target: ComputerTarget,
    signal: AbortSignal,
    limits?: CaptureLimits,
    screenshot = false,
  ) {
    if (!target.app.trim()) throw new ComputerError("invalid_input", "observe requires app");
    if (
      target.projection !== undefined &&
      !["full", "compact", "overview"].includes(target.projection)
    )
      throw new ComputerError("invalid_input", "Invalid observation projection");
    if (
      (target.frameId !== undefined) !== (target.rootIndex !== undefined) ||
      (target.rootIndex !== undefined &&
        (!Number.isSafeInteger(target.rootIndex) ||
          target.rootIndex < 0 ||
          target.rootIndex > 799)) ||
      (target.rootIndex !== undefined && target.surface)
    )
      throw new ComputerError(
        "invalid_input",
        "Region observation requires frameId and rootIndex, without surface",
      );
    return this.operate(owner, signal, (lease, current) => {
      if (target.rootIndex !== undefined) {
        const previous = lease.accessibility;
        if (!previous || previous.frame.id !== target.frameId)
          throw new ComputerError("stale_frame", "区域观察需要最新 frameId");
        if (previous.surface === "menu_bar")
          throw new ComputerError("invalid_input", "请先打开菜单栏面板，再观察窗口区域");
        if (
          !lease.appAliases?.names.has(target.app.trim().toLowerCase()) ||
          (target.windowTitle !== undefined && target.windowTitle !== previous.state.windowTitle)
        )
          throw new ComputerError(
            "invalid_input",
            "Region observation must retain the observed app and window",
          );
        return this.observeApp(
          lease,
          {
            app: previous.state.app,
            previousId: previous.state.id,
            rootIndex: target.rootIndex,
            projection: target.projection ?? previous.state.observation?.projection,
          },
          current,
          limits,
          screenshot,
        );
      }
      return this.observeApp(lease, target, current, limits, screenshot);
    });
  }

  private observationTarget(
    state: ComputerAccessibility,
  ): Pick<ComputerTarget, "projection" | "rootIndex"> {
    return {
      ...(state.observation ? { projection: state.observation.projection } : {}),
      ...(state.observation?.scope === "region" ? { rootIndex: 0 } : {}),
    };
  }

  private async observeApp(
    lease: Lease,
    target: ComputerTarget,
    signal: AbortSignal,
    limits?: CaptureLimits,
    screenshot = false,
    previousState?: ComputerAccessibility,
  ) {
    if (!this.adapter.accessibility)
      throw new ComputerError(
        "invalid_input",
        "当前宿主不支持辅助功能；请使用 screenshot 和坐标操作",
      );
    lease.frame = undefined;
    lease.accessibility = undefined;
    const state = await this.adapter.accessibility.observe(target, signal);
    this.check(lease, signal);
    if (lease.appAliases?.resolved !== state.app)
      lease.appAliases = { resolved: state.app, names: new Set() };
    lease.appAliases.names.add(target.app.trim().toLowerCase());
    lease.appAliases.names.add(state.app.trim().toLowerCase());
    lease.presented = state;
    const captured = screenshot
      ? await this.capture(lease, signal, limits, previousState !== undefined, state)
      : undefined;
    this.check(lease, signal);
    const frame = captured?.frame ?? {
      id: randomUUID(),
      displayId: "accessibility",
      imageWidth: 0,
      imageHeight: 0,
      capturedAt: Date.now(),
    };
    // A baked observation cursor would leave a ghost behind the live preview pointer.
    const preview = !state.cursor || limits?.includeCursor === false ? captured?.image : undefined;
    await this.present(lease, state, signal, preview);
    this.check(lease, signal);
    lease.accessibility = {
      state,
      frame,
      screenshot,
      ...(target.surface ? { surface: target.surface } : {}),
    };
    const sameProjection =
      previousState &&
      previousState.observation?.scope === state.observation?.scope &&
      previousState.observation?.projection === state.observation?.projection &&
      !state.observation?.fallback;
    return {
      frame,
      ...(captured ? { image: captured.image } : {}),
      accessibility: sameProjection
        ? accessibilityDiff(previousState.text, state.text)
        : state.text,
      app: state.app,
      windowTitle: state.windowTitle,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      ...(state.observation ? { observation: state.observation } : {}),
    };
  }

  /** Abort first, then wait for actual adapter completion before allowing a replacement owner. */
  release(owner: ComputerOwner): Promise<void> {
    const lease = this.lease;
    if (!lease || lease.owner !== owner) return Promise.resolve();
    if (lease.releasing) return lease.releasing;
    clearTimeout(lease.timer);
    lease.controller.abort(new ComputerError("cancelled", "桌面控制已停止"));
    this.publish(lease, { type: "end", id: lease.id });
    lease.releasing = (async () => {
      await lease.pending?.catch(() => {});
      try {
        await this.adapter.checkOwnership?.(AbortSignal.timeout(4500));
      } catch (error) {
        if (error instanceof ComputerError && error.code === "user_interrupted")
          this.stopped.add(owner);
        else if (!(error instanceof ComputerError && error.code === "stale_frame")) throw error;
      } finally {
        await this.releaseInputs(lease);
        await this.adapter.accessibility?.reset();
        if (this.lease === lease) this.lease = undefined;
      }
    })();
    const releasing = lease.releasing;
    void releasing.catch(() => {
      if (lease.releasing === releasing) lease.releasing = undefined;
    });
    return lease.releasing;
  }

  private check(lease: Lease, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.lease !== lease || !lease.owner.active())
      throw new ComputerError("cancelled", "本次桌面操作已失效");
  }

  private async releaseInputs(lease: Lease) {
    try {
      await this.adapter.releaseInputs();
    } catch (error) {
      lease.controller.abort(error);
      throw error;
    }
  }

  private async capture(
    lease: Lease,
    signal: AbortSignal,
    limits?: CaptureLimits,
    afterInput = false,
    target?: ComputerAccessibility,
  ) {
    lease.accessibility = undefined;
    const capture = await this.adapter.capture(signal, limits, afterInput, target);
    this.check(lease, signal);
    if (
      capture.width > (limits?.maxWidth ?? Infinity) ||
      capture.height > (limits?.maxHeight ?? Infinity) ||
      capture.image.data.length > (limits?.maxBytes ?? 3_000_000)
    )
      throw new ComputerError("invalid_frame", "截图不满足当前模型限制，请调整捕获尺寸");
    if (
      !Number.isSafeInteger(capture.width) ||
      !Number.isSafeInteger(capture.height) ||
      capture.width <= 0 ||
      capture.height <= 0 ||
      !Object.values(capture.layout.bounds).every(Number.isFinite) ||
      capture.layout.bounds.width <= 0 ||
      capture.layout.bounds.height <= 0
    )
      throw new ComputerError("invalid_frame", "截图尺寸无效");
    const frame: ComputerFrame = {
      id: randomUUID(),
      ...(capture.excludesChildWindows ? { excludesChildWindows: true } : {}),
      displayId: capture.layout.id,
      imageWidth: capture.width,
      imageHeight: capture.height,
      capturedAt: Date.now(),
      ...(capture.observation ? { observation: capture.observation } : {}),
    };
    // Bind input to the exact delivered image geometry.
    lease.frame = {
      capture: {
        ...capture,
        layout: structuredClone(capture.layout),
        image: { ...capture.image },
      },
      frame,
    };
    return { frame, image: capture.image };
  }

  private async operate<T>(
    owner: ComputerOwner,
    signal: AbortSignal,
    action: (lease: Lease, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (!owner.active()) throw new ComputerError("cancelled", "本次桌面操作已失效");
    if (this.stopped.has(owner))
      throw new ComputerError(
        "user_interrupted",
        "你已停止桌面控制；本次任务不能恢复，请等待新的用户指令",
      );
    if (!this.lease) {
      const lease: Lease = { id: randomUUID(), owner, controller: new AbortController() };
      lease.timer = setTimeout(
        () => {
          void this.release(owner).catch(() => {});
        },
        10 * 60 * 1000,
      );
      lease.timer.unref();
      this.lease = lease;
      this.publish(lease, { type: "start", id: lease.id });
    }
    const lease = this.lease;
    if (lease.owner !== owner || lease.pending || lease.releasing)
      throw new ComputerError("busy", "桌面正由另一次操作使用");
    const current = AbortSignal.any([signal, lease.controller.signal, AbortSignal.timeout(30000)]);
    // Install the pending operation before invoking adapter code, including synchronous callbacks.
    const pending = Promise.resolve().then(async () => {
      this.check(lease, current);
      try {
        return await action(lease, current);
      } catch (error) {
        if (error instanceof ComputerError && error.code === "user_interrupted") {
          this.stopped.add(owner);
          lease.frame = undefined;
          lease.accessibility = undefined;
        }
        throw error;
      } finally {
        await this.releaseInputs(lease);
      }
    });
    lease.pending = pending;
    try {
      return await pending;
    } finally {
      if (lease.pending === pending) lease.pending = undefined;
    }
  }
}

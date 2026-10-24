import { createHash } from "node:crypto";
import { observeAfterInput } from "./observation.ts";
import { ComputerError } from "../protocol.ts";
import type { createAccessibilityBridge } from "./accessibility.ts";
import type { ComputerAdapter, ComputerAccessibility } from "../protocol.ts";

/** Platform permission checks and launch stay with the host; all input is window-scoped. */
export interface MacComputerHost {
  permissions(): { screen: boolean; accessibility: boolean };
  openApplication(name: string, signal: AbortSignal): Promise<void>;
  accessibility: ReturnType<typeof createAccessibilityBridge>;
}

/** There is deliberately no global mouse/keyboard backend or foreground fallback. */
export function createMacComputerAdapter(host: MacComputerHost): ComputerAdapter {
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted();
    host.accessibility.assertHealthy();
    const permissions = host.permissions();
    if (!permissions.screen || !permissions.accessibility)
      throw new Error("请在 macOS 系统设置中允许屏幕录制和辅助功能后重试");
  };
  const target = (state?: ComputerAccessibility) => {
    if (!state)
      throw new ComputerError(
        "invalid_input",
        "请先 observe(app) 或 screenshot(app)，以选择目标窗口",
      );
    return state;
  };
  return {
    checkOwnership: (signal) => host.accessibility.checkOwnership(signal, true),
    layout: async (signal, state) => {
      check(signal);
      return host.accessibility.layout(target(state), signal);
    },
    capture: async (signal, limits, afterInput, state) => {
      check(signal);
      const selected = target(state);
      const settled = afterInput
        ? await observeAfterInput({
            signal,
            capture: async () => {
              const sample = await host.accessibility.capture(selected, signal, {
                ...limits,
                maxWidth: Math.min(160, limits?.maxWidth ?? 160),
                maxHeight: Math.min(160, limits?.maxHeight ?? 160),
              });
              return createHash("sha256").update(sample.image.data).digest("hex");
            },
          })
        : undefined;
      const result = await host.accessibility.capture(selected, signal, limits);
      check(signal);
      return { ...result, ...(settled ? { observation: settled.observation } : {}) };
    },
    input: async (input, signal) => {
      check(signal);
      if (input.action !== "open")
        throw new ComputerError("invalid_input", "输入需要已观察的目标窗口；请先 observe(app)");
      await host.accessibility.checkOwnership(signal);
      check(signal);
      await host.openApplication(input.app, signal);
      check(signal);
    },
    accessibility: {
      observe: async (selected, signal) => {
        check(signal);
        return host.accessibility.observe(selected, signal);
      },
      input: async (state, input, signal) => {
        check(signal);
        await host.accessibility.execute(state, input.action, input, signal);
        check(signal);
      },
      reset: () => host.accessibility.reset(),
    },
    // Each native operation releases its held input in defer, including cooperative termination.
    releaseInputs: async () => {
      host.accessibility.assertHealthy();
    },
  };
}

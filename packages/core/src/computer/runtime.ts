import { LiveDoc, ROOT_CONVERSATION_ID } from "@eta/agent";
import type { Harness } from "@eta/agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerExtension } from "./extension.ts";
import type { ComputerService, ComputerOwner } from "@eta/computer-use/service";

/** The first admitted submission survives generation handoffs; the watch scopes it to this Harness. */
export async function createComputerRuntime(options: {
  harness: Harness;
  service: ComputerService;
  allowed(): Promise<boolean>;
}) {
  const watch = await options.harness.watchDoc(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
  if (!watch) throw new Error("桌面控制缺少根 conversation 状态");
  const owners = new Map<number, ComputerOwner>();
  let closed = false;
  let enabled = false;
  const releaseAll = async () => {
    await Promise.all(
      [...owners].map(async ([id, owner]) => {
        await options.service.release(owner);
        if (owners.get(id) === owner) owners.delete(id);
      }),
    );
  };
  watch.start(async (state) => {
    // Do not visit owners admitted while an older cleanup is awaiting native completion.
    const retiring = [...owners].filter(([id]) => state?.run?.inputs[0] !== id);
    for (const [id, owner] of retiring) {
      await options.service.release(owner);
      if (owners.get(id) === owner) owners.delete(id);
    }
  });
  const extension = createComputerExtension({
    service: options.service,
    allowed: () => options.allowed(),
    owner: async (api, context) => {
      const state = await api.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
      const id = state?.run?.inputs[0];
      if (closed || !enabled || !id || watch.value?.run?.inputs[0] !== id)
        throw new Error("本次桌面控制请求已失效");
      let owner = owners.get(id);
      if (!owner) {
        const admitted: ComputerOwner = {
          active: () =>
            !closed && enabled && owners.get(id) === admitted && watch.value?.run?.inputs[0] === id,
        };
        owner = admitted;
        owners.set(id, owner);
      }
      return owner;
    },
  });
  return {
    extension,
    refresh: async () => {
      const allowed = await options.allowed();
      enabled = allowed;
      if (!allowed) await releaseAll();
    },
    close: async () => {
      closed = true;
      await watch.stop();
      await releaseAll();
    },
  };
}

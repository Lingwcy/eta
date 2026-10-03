import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopBridge } from "./bridge.ts";
import type { CommandReply } from "./bridge.ts";
import { unwrapReply } from "./command-reply.ts";

async function invoke<A>(channel: string, ...args: unknown[]): Promise<A> {
  return unwrapReply((await ipcRenderer.invoke(channel, ...args)) as CommandReply<A>);
}

const bridge: DesktopBridge = {
  library: () => invoke("eta:command", { type: "library" }),
  chooseProject: () => invoke("eta:choose-project"),
  chooseDirectory: () => invoke("eta:choose-directory"),
  registerProject: (rootPath, name) =>
    invoke("eta:command", { type: "register-project", rootPath, name }),
  createThread: (workspaceId, requestId) =>
    invoke("eta:command", { type: "create", workspaceId, requestId }),
  openThread: (id) => invoke("eta:command", { type: "open", id }),
  renameThread: (id, title) => invoke("eta:command", { type: "rename", id, title }),
  archiveThread: (id, archived) => invoke("eta:command", { type: "archive", id, archived }),
  configureThread: (id, provider, modelId, thinkingLevel) =>
    invoke("eta:command", { type: "configure", id, provider, modelId, thinkingLevel }),
  submit: (id, prompt) =>
    invoke("eta:command", {
      type: "submit",
      id,
      prompt,
      requestId: globalThis.crypto.randomUUID(),
    }),
  stop: (id) => invoke("eta:command", { type: "stop", id }),
  resume: (id) => invoke("eta:command", { type: "resume", id }),
  compact: (id) => invoke("eta:command", { type: "compact", id }),
  updateSettings: (patch) => invoke("eta:command", { type: "settings", patch }),
  setApiKey: (provider, key) => invoke("eta:command", { type: "credential", provider, key }),
  removeCredential: (provider) => invoke("eta:command", { type: "logout", provider }),
  subscribe(sessionId, listener) {
    const subscriptionId = globalThis.crypto.randomUUID();
    const onEvent = (
      _event: Electron.IpcRendererEvent,
      message: { sessionId: string; subscriptionId: string; event: AgentEvent },
    ) => {
      if (message.sessionId === sessionId && message.subscriptionId === subscriptionId)
        listener(message.event);
    };
    ipcRenderer.on("agent:event", onEvent);
    ipcRenderer.send("agent:watch", sessionId, subscriptionId);
    return () => {
      ipcRenderer.removeListener("agent:event", onEvent);
      ipcRenderer.send("agent:unwatch", subscriptionId);
    };
  },
};

contextBridge.exposeInMainWorld("eta", bridge);

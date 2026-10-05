import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopBridge } from "./bridge.ts";
import type { CommandReply } from "./bridge.ts";
import { unwrapReply } from "./command-reply.ts";
import type { BrowserEvent } from "./browser/protocol.ts";

async function invoke<A>(channel: string, ...args: unknown[]): Promise<A> {
  return unwrapReply((await ipcRenderer.invoke(channel, ...args)) as CommandReply<A>);
}

const bridge: DesktopBridge = {
  skills: (cwd) => invoke("eta:command", { type: "skills", ...(cwd ? { cwd } : {}) }),
  openSkillsDirectory: (path, cwd) =>
    invoke("eta:command", { type: "open-skills-directory", path, ...(cwd ? { cwd } : {}) }),
  unloadSkill: (id, name) => invoke("eta:command", { type: "unload-skill", id, name }),
  subscribeLibrary(listener) {
    ipcRenderer.on("eta:library-changed", listener);
    return () => ipcRenderer.removeListener("eta:library-changed", listener);
  },
  openThreadWindow: (id) => invoke("eta:thread-window", id),
  openThreadFile: (id, mode) => invoke("eta:thread-file", id, mode),
  moveThread: (id, projectId) => invoke("eta:command", { type: "move-thread", id, projectId }),
  deleteThread: (id) => invoke("eta:command", { type: "delete-thread", id }),
  storage: () => invoke("eta:command", { type: "storage" }),
  revealStorage: (target) => invoke("eta:command", { type: "reveal-storage", target }),
  browser: (command) => invoke("browser:command", command),
  subscribeBrowser(listener) {
    const onEvent = (_event: Electron.IpcRendererEvent, value: BrowserEvent) => listener(value);
    ipcRenderer.on("browser:event", onEvent);
    return () => ipcRenderer.removeListener("browser:event", onEvent);
  },
  prepareImage: (source, cwd, provider, modelId) =>
    invoke("eta:command", {
      type: "prepare-image",
      source,
      ...(cwd === undefined ? {} : { cwd }),
      ...(provider === undefined ? {} : { provider }),
      ...(modelId === undefined ? {} : { modelId }),
    }),
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
  submit: (id, prompt, images) =>
    invoke("eta:command", {
      type: "submit",
      id,
      prompt,
      ...(images === undefined ? {} : { images }),
      requestId: globalThis.crypto.randomUUID(),
    }),
  stop: (id) => invoke("eta:command", { type: "stop", id }),
  resume: (id) => invoke("eta:command", { type: "resume", id }),
  compact: (id) => invoke("eta:command", { type: "compact", id }),
  updateSettings: (patch) => invoke("eta:command", { type: "settings", patch }),
  startLogin: (provider, method) =>
    invoke("eta:command", { type: "login-start", provider, method }),
  loginState: (id) => invoke("eta:command", { type: "login-state", id }),
  answerLogin: (id, promptId, value) =>
    invoke("eta:command", { type: "login-answer", id, promptId, value }),
  cancelLogin: (id) => invoke("eta:command", { type: "login-cancel", id }),
  openLoginLink: (id, url) => invoke("eta:command", { type: "login-open", id, url }),
  removeCredential: (provider, method) =>
    invoke("eta:command", { type: "logout", provider, method }),
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

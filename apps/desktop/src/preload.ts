import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopBridge } from "./bridge.ts";

const bridge: DesktopBridge = {
  createSession: () => ipcRenderer.invoke("agent:create-session"),
  submit: (sessionId, prompt) => ipcRenderer.invoke("agent:submit", sessionId, prompt),
  stop: (sessionId) => ipcRenderer.invoke("agent:stop", sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke("agent:delete-session", sessionId),
  subscribe(sessionId, listener) {
    const onEvent = (
      _event: Electron.IpcRendererEvent,
      message: { sessionId: string; event: AgentEvent },
    ) => {
      if (message.sessionId === sessionId) listener(message.event);
    };
    ipcRenderer.on("agent:event", onEvent);
    ipcRenderer.send("agent:watch", sessionId);
    return () => {
      ipcRenderer.removeListener("agent:event", onEvent);
      ipcRenderer.send("agent:unwatch", sessionId);
    };
  },
};

contextBridge.exposeInMainWorld("eta", bridge);

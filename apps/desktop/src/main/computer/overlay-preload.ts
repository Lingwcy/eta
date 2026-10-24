import { contextBridge, ipcRenderer } from "electron";
import type { ComputerOverlayState } from "./overlay.ts";

contextBridge.exposeInMainWorld("etaComputerOverlay", {
  subscribe(listener: (state: ComputerOverlayState) => void) {
    const receive = (_event: Electron.IpcRendererEvent, state: ComputerOverlayState) =>
      listener(state);
    ipcRenderer.on("eta:computer-overlay-state", receive);
    ipcRenderer.send("eta:computer-overlay-ready");
    return () => ipcRenderer.removeListener("eta:computer-overlay-state", receive);
  },
  stop(id: string) {
    ipcRenderer.send("eta:computer-overlay-stop", id);
  },
});

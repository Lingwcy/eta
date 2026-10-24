import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopBridge } from "./bridge.ts";
import type { CommandReply, UpdateState } from "./bridge.ts";
import type { OperationAdmission } from "@eta/core/agent/protocol";
import { unwrapReply } from "./command-reply.ts";
import type { BrowserEvent } from "./browser/protocol.ts";

async function invoke<A>(channel: string, ...args: unknown[]): Promise<A> {
  return unwrapReply((await ipcRenderer.invoke(channel, ...args)) as CommandReply<A>);
}

function submitReply(
  ...[id, prompt, images, requestId]: Parameters<DesktopBridge["submit"]>
): Promise<CommandReply<OperationAdmission>> {
  return ipcRenderer.invoke("eta:command", {
    type: "submit",
    id,
    prompt,
    ...(images === undefined ? {} : { images }),
    requestId: requestId ?? globalThis.crypto.randomUUID(),
  });
}

const bridge: DesktopBridge = {
  scheduleSnapshot: () => invoke("eta:command", { type: "schedule-snapshot" }),
  writeSchedule: (input) => invoke("eta:command", { type: "schedule-write", input }),
  proposeSchedule: (input) => invoke("eta:command", { type: "schedule-propose", input }),
  decideSchedule: (input, approved) =>
    invoke("eta:command", { type: "schedule-decide", input, approved }),
  runSchedule: (input) => invoke("eta:command", { type: "schedule-run", input }),
  scheduleRuns: (scheduleId) => invoke("eta:command", { type: "schedule-runs", scheduleId }),
  scheduleRequest: (threadId, requestId) =>
    invoke("eta:command", { type: "schedule-request", threadId, requestId }),
  subscribeSchedules(listener) {
    ipcRenderer.on("eta:schedules-changed", listener);
    return () => ipcRenderer.removeListener("eta:schedules-changed", listener);
  },
  importBotCredentials: () => invoke("eta:command", { type: "bot-import-credentials" }),
  removeBotCredential: (providerId) =>
    invoke("eta:command", { type: "bot-remove-credential", providerId }),
  connectBot: (connection) => invoke("eta:command", { type: "bot-connect", connection }),
  disconnectBot: () => invoke("eta:command", { type: "bot-disconnect" }),
  reconnectBot: () => invoke("eta:command", { type: "bot-reconnect" }),
  subagent: (id, command) =>
    invoke("eta:command", {
      type: "subagent",
      id,
      command,
      requestId: globalThis.crypto.randomUUID(),
    }),
  skills: (cwd, workspaceId) =>
    invoke("eta:command", {
      type: "skills",
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    }),
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
  createCloudProject: (name, requestId) =>
    invoke("eta:command", { type: "create-cloud-project", name, requestId }),
  registerProject: (rootPath, name) =>
    invoke("eta:command", { type: "register-project", rootPath, name }),
  createThread: (workspaceId, requestId, configuration, environment) =>
    invoke("eta:command", {
      type: "create",
      workspaceId,
      requestId,
      ...(configuration ? { configuration } : {}),
      ...(environment ? { environment } : {}),
    }),
  openThread: (id) => invoke("eta:command", { type: "open", id }),
  openThreadReply: (id) => ipcRenderer.invoke("eta:command", { type: "open", id }),
  operation: (id, operationId) => invoke("eta:command", { type: "operation", id, operationId }),
  configureSandbox: (id, mode) => invoke("eta:command", { type: "configure-sandbox", id, mode }),
  decideApproval: (id, requestId, approved, reuse) =>
    invoke("eta:command", {
      type: "decide-approval",
      id,
      requestId,
      approved,
      ...(reuse ? { reuse } : {}),
    }),
  reviewStats: () => invoke("eta:command", { type: "review-stats" }),
  githubIdentity: (projectId) => invoke("eta:command", { type: "github-identity", projectId }),
  githubQuery: (input) => invoke("eta:command", { type: "github-query", input }),
  gitRepository: (workspaceId) => invoke("eta:command", { type: "git-repository", workspaceId }),
  gitBranches: (workspaceId) => invoke("eta:command", { type: "git-branches", workspaceId }),
  selectGitHubRemote: (projectId, remoteName, requestId) =>
    invoke("eta:command", {
      type: "select-github-remote",
      projectId,
      remoteName,
      ...(requestId ? { requestId } : {}),
    }),
  listWorktrees: (projectId) => invoke("eta:command", { type: "list-worktrees", projectId }),
  reconcileWorktrees: (projectId) =>
    invoke("eta:command", { type: "reconcile-worktrees", projectId }),
  createWorktree: (input) => invoke("eta:command", { type: "create-worktree", input }),
  removeWorktree: (workspaceId, requestId) =>
    invoke("eta:command", { type: "remove-worktree", workspaceId, requestId }),
  renameThread: (id, title) => invoke("eta:command", { type: "rename", id, title }),
  archiveThread: (id, archived) => invoke("eta:command", { type: "archive", id, archived }),
  configureThread: (id, provider, modelId, thinkingLevel) =>
    invoke("eta:command", { type: "configure", id, provider, modelId, thinkingLevel }),
  submit: async (...args) => unwrapReply(await submitReply(...args)),
  submitReply,
  stop: (id) => invoke("eta:command", { type: "stop", id }),
  resume: (id) => invoke("eta:command", { type: "resume", id }),
  compact: (id) => invoke("eta:command", { type: "compact", id }),
  updateSettings: (patch) => invoke("eta:command", { type: "settings", patch }),
  computerStatus: () => invoke("eta:command", { type: "computer-status" }),
  openComputerPermissions: (permission) =>
    invoke("eta:command", { type: "computer-permission", permission }),
  startLogin: (provider, method) =>
    invoke("eta:command", { type: "login-start", provider, method }),
  loginState: (id) => invoke("eta:command", { type: "login-state", id }),
  answerLogin: (id, promptId, value) =>
    invoke("eta:command", { type: "login-answer", id, promptId, value }),
  cancelLogin: (id) => invoke("eta:command", { type: "login-cancel", id }),
  openLoginLink: (id, url) => invoke("eta:command", { type: "login-open", id, url }),
  removeCredential: (provider, method) =>
    invoke("eta:command", { type: "logout", provider, method }),
  appInfo: () => invoke("eta:update", "app-info"),
  updateState: () => invoke("eta:update", "state"),
  checkForUpdates: () => invoke("eta:update", "check"),
  installUpdate: () => invoke("eta:update", "install"),
  openReleasePage: () => invoke("eta:update", "release-page"),
  subscribeUpdate(listener) {
    const onEvent = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on("eta:update-state", onEvent);
    return () => ipcRenderer.removeListener("eta:update-state", onEvent);
  },
  subscribe(sessionId, listener, path) {
    const subscriptionId = globalThis.crypto.randomUUID();
    const onEvent = (
      _event: Electron.IpcRendererEvent,
      message: { sessionId: string; subscriptionId: string; event: AgentEvent },
    ) => {
      if (message.sessionId === sessionId && message.subscriptionId === subscriptionId)
        listener(message.event);
    };
    ipcRenderer.on("agent:event", onEvent);
    ipcRenderer.send("agent:watch", sessionId, subscriptionId, path);
    return () => {
      ipcRenderer.removeListener("agent:event", onEvent);
      ipcRenderer.send("agent:unwatch", subscriptionId);
    };
  },
};

contextBridge.exposeInMainWorld("eta", bridge);

import { ipcMain } from "electron";
import type { AgentEvent } from "../../bridge.ts";
import type { DesktopApplication } from "../bootstrap.ts";
import { sessionId } from "./validation.ts";

export function createAgentSubscriptions(service: () => Pick<DesktopApplication, "subscribe">) {
  type Watch = { token: symbol; unsubscribe?: () => void };
  /**
   * 按窗口维护活跃会话订阅的二级账本：
   * Map<contentsId (窗口 ID), Map<subscriptionId (订阅 UUID), Watch (订阅实例)>>
   * 外层key按窗口划分：窗口销毁时，可通过 contents.id 批量注销其关联的所有监听，避免内存泄漏。
   * 内层key按 subscriptionId 区分：同一窗口内不同组件、Tab 或后台活动监听器可独立订阅与退订。
   */
  const watchers = new Map<number, Map<string, Watch>>();

  function stopWatching(contentsId: number, id: string) {
    const sessions = watchers.get(contentsId);
    const watch = sessions?.get(id);
    if (!watch) return;
    sessions?.delete(id);
    watch.unsubscribe?.();
    if (sessions?.size === 0) watchers.delete(contentsId);
  }

  ipcMain.on(
    "agent:watch",
    (event, rawId: unknown, rawSubscriptionId: unknown, rawPath?: unknown) => {
      let id: string;
      let subscriptionId: string;
      // 参数校验
      try {
        id = sessionId(rawId);
        subscriptionId = sessionId(rawSubscriptionId);
        if (rawPath !== undefined) sessionId(rawPath);
      } catch (error) {
        event.sender.send("agent:event", {
          sessionId: typeof rawId === "string" ? rawId : "",
          subscriptionId: typeof rawSubscriptionId === "string" ? rawSubscriptionId : "",
          event: { type: "error", message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
      const contents = event.sender;
      let sessions = watchers.get(contents.id);
      if (!sessions) watchers.set(contents.id, (sessions = new Map()));
      if (sessions.has(subscriptionId)) return;
      const watch: Watch = { token: Symbol() };
      sessions.set(subscriptionId, watch);
      // 安全发送器
      const send = (agentEvent: AgentEvent) => {
        // 确保窗口还没被用户关闭，避免对已销毁的 WebContents 发送 IPC导致崩溃。
        // Token校验。确保当前的订阅依然是发起该请求时的同一个订阅，防止订阅在短时间内被取消重连时产生串话/脏消息。
        if (!contents.isDestroyed() && sessions?.get(subscriptionId)?.token === watch.token)
          contents.send("agent:event", { sessionId: id, subscriptionId, event: agentEvent });
      };
      // 加上 void 明确向编译器声明 这里有意将其放入后台执行（Fire-and-Forget），不需要等待它完成。
      // 在同步执行时抛出异常（例如应用退出抛出RuntimeClosing 或尚未初始化抛出 Agent 尚未就绪） 由catch统一捕获
      void Promise.resolve()
        // 建立底层订阅通道
        .then(() =>
          service().subscribe(
            id,
            (value) => send({ type: "snapshot", value }),
            (message) => send({ type: "error", message }),
            typeof rawPath === "string" ? rawPath : undefined,
          ),
        )
        // subscribe 会返回 unsubscribe 取消订阅函数
        .then((unsubscribe) => {
          // 如果这期间renderer把窗口关了或者已经调用了 unwatch（从 Map中删除了该项或被新订阅替代）；
          if (contents.isDestroyed() || sessions?.get(subscriptionId)?.token !== watch.token)
            unsubscribe();
          // 如果依然有效：将 unsubscribe 保存到 watch.unsubscribe
          // 上。后续当渲染进程主动发送 agent:unwatch
          // 时，stopWatching 就能调用该函数完成清理。
          else watch.unsubscribe = unsubscribe;
        })
        .catch((error: unknown) => {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          if (sessions?.get(subscriptionId)?.token === watch.token)
            stopWatching(contents.id, subscriptionId);
        });
    },
  );

  ipcMain.on("agent:unwatch", (event, rawId: unknown) => {
    if (typeof rawId === "string") stopWatching(event.sender.id, rawId);
  });

  const disposeWindow = (contentsId: number) => {
    for (const id of watchers.get(contentsId)?.keys() ?? []) stopWatching(contentsId, id);
  };
  const dispose = () => {
    for (const contentsId of watchers.keys()) disposeWindow(contentsId);
  };
  return { disposeWindow, dispose };
}

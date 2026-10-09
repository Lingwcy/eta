import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, CredentialStore, Models } from "@earendil-works/pi-ai";
import type { AuthProvider, LoginMethod, LoginState } from "../../authentication.ts";
import { CoreError } from "@eta/core/service/errors";

type Flow = {
  state: LoginState;
  controller: AbortController;
  answer?: (value: string) => void;
  task?: Promise<void>;
};

/** Desktop adapts pi-ai's login interaction; pi-ai owns token exchange and credential writes. */
export class DesktopAuthentication {
  private flow?: Flow;
  private removing = false;

  constructor(
    private readonly models: Models,
    private readonly credentials: CredentialStore,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly deviceId: string,
  ) {}

  providers(): AuthProvider[] {
    return this.models
      .getProviders()
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        accountLabel: provider.auth.oauth?.name,
        methods: [
          ...(provider.auth.oauth ? ["oauth" as const] : []),
          ...(provider.auth.apiKey?.login ? ["api_key" as const] : []),
        ],
      }))
      .filter((provider) => provider.methods.length)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  start(provider: string, method: LoginMethod) {
    if (this.removing || this.flow?.state.status === "running")
      throw new CoreError({ code: "Busy", message: "请先完成或取消当前登录" });
    if (!this.providers().some((entry) => entry.id === provider && entry.methods.includes(method)))
      throw new CoreError({ code: "InvalidInput", message: "该服务不支持此登录方式" });
    const flow: Flow = {
      state: {
        id: randomUUID(),
        provider,
        method,
        status: "running",
        message: "准备连接…",
        links: [],
      },
      controller: new AbortController(),
    };
    this.flow = flow;
    flow.task = this.models
      .login(
        provider,
        method,
        {
          signal: flow.controller.signal,
          prompt: (prompt) => this.prompt(flow, prompt),
          notify: (event) => this.notify(flow, event),
        },
        { getDeviceId: () => this.deviceId },
      )
      .then(
        () => {
          flow.state = { ...flow.state, status: "completed", message: "已连接", prompt: undefined };
        },
        () => {
          flow.state = {
            ...flow.state,
            status: flow.controller.signal.aborted ? "cancelled" : "failed",
            message: flow.controller.signal.aborted
              ? "已取消登录"
              : "登录未完成，请检查授权或配置后重试。",
            prompt: undefined,
          };
        },
      );
    return structuredClone(flow.state);
  }

  read(id: string) {
    return structuredClone(this.requireFlow(id).state);
  }

  answer(id: string, promptId: string, value: string) {
    const flow = this.requireFlow(id);
    const prompt = flow.state.prompt;
    if (flow.state.status !== "running" || prompt?.id !== promptId || !flow.answer)
      throw new CoreError({ code: "InvalidInput", message: "此登录步骤已结束" });
    if (prompt.type === "select" && !prompt.options?.some((option) => option.id === value))
      throw new CoreError({ code: "InvalidInput", message: "请选择有效选项" });
    flow.answer(value);
  }

  async cancel(id: string) {
    const flow = this.requireFlow(id);
    if (flow.state.status !== "running") return;
    flow.controller.abort();
    await flow.task;
  }

  async openLink(id: string, url: string) {
    const flow = this.requireFlow(id);
    if (!flow.state.links.some((link) => link.url === url))
      throw new CoreError({ code: "InvalidInput", message: "授权链接无效" });
    await this.openExternal(this.webUrl(url));
  }

  async remove(provider: string, method: LoginMethod) {
    if (this.flow?.state.status === "running" && this.flow.state.provider === provider)
      throw new CoreError({ code: "Busy", message: "请先取消此服务的登录" });
    if (this.removing) throw new CoreError({ code: "Busy", message: "正在更新连接" });
    this.removing = true;
    try {
      const current = await this.credentials.read(provider);
      if (current?.type !== method)
        throw new CoreError({
          code: "InvalidInput",
          message: "该登录方式已被替换，请刷新设置",
        });
      await this.models.logout(provider);
    } finally {
      this.removing = false;
    }
  }

  async close() {
    if (this.flow?.state.status === "running") await this.cancel(this.flow.state.id);
  }

  private requireFlow(id: string) {
    if (!this.flow || this.flow.state.id !== id)
      throw new CoreError({ code: "NotFound", message: "登录已结束，请重新连接" });
    return this.flow;
  }

  private webUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new CoreError({ code: "InvalidInput", message: "授权链接无效" });
    return parsed.href;
  }

  private prompt(flow: Flow, prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal
      ? AbortSignal.any([flow.controller.signal, prompt.signal])
      : flow.controller.signal;
    signal.throwIfAborted();
    const id = randomUUID();
    flow.state = {
      ...flow.state,
      prompt: {
        id,
        type: prompt.type,
        message: prompt.message,
        ...(prompt.type === "select"
          ? { options: prompt.options }
          : { placeholder: prompt.placeholder }),
      },
    };
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        if (flow.state.prompt?.id === id) {
          flow.state = { ...flow.state, prompt: undefined };
          flow.answer = undefined;
        }
      };
      const abort = () => {
        finish();
        reject(signal.reason);
      };
      flow.answer = (value) => {
        finish();
        resolve(value);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private notify(flow: Flow, event: AuthEvent) {
    if (flow.controller.signal.aborted) return;
    let links: { url: string; label?: string }[] = [];
    switch (event.type) {
      case "auth_url":
        links = [{ url: this.webUrl(event.url), label: "在浏览器中继续" }];
        flow.state = { ...flow.state, message: event.instructions ?? "请在浏览器中完成授权" };
        break;
      case "device_code":
        links = [{ url: this.webUrl(event.verificationUri), label: "打开授权页面" }];
        flow.state = {
          ...flow.state,
          deviceCode: event.userCode,
          message: "在授权页面输入下方设备码",
        };
        break;
      case "info":
        links = (event.links ?? []).map((link) => ({ ...link, url: this.webUrl(link.url) }));
        flow.state = { ...flow.state, message: event.message };
        break;
      case "progress":
        flow.state = { ...flow.state, message: event.message };
    }
    const known = new Set(flow.state.links.map((link) => link.url));
    flow.state = {
      ...flow.state,
      links: [...flow.state.links, ...links.filter((link) => !known.has(link.url))],
    };
    if (event.type === "auth_url" || event.type === "device_code") {
      const link = links[0];
      if (link)
        void this.openExternal(link.url).catch(() => {
          if (flow.state.status === "running")
            flow.state = { ...flow.state, message: "请点击下方按钮打开授权页面" };
        });
    }
  }
}

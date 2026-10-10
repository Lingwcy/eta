import type { CreateThreadConfiguration, ThinkingLevel } from "@eta/core/agent/protocol";
import type { ImageAttachment } from "@eta/core/images/types";
import type { DesktopBridge } from "../../../src/bridge.ts";

type DraftBridge = Pick<DesktopBridge, "submit"> &
  Partial<Pick<DesktopBridge, "configureThread">> & {
    createThread(
      workspaceId: string,
      requestId: string,
      configuration?: CreateThreadConfiguration,
    ): Promise<{ id: string }>;
  };

/** A draft has no session until its first submit; retries reuse the persisted binding. */
export class DraftThread {
  private threadId?: string;
  private workspaceId?: string;
  private pending?: Promise<string>;

  constructor(
    readonly requestId: string,
    private readonly bridge: DraftBridge,
  ) {}

  submit(
    workspaceId: string | null,
    prompt: string,
    images?: readonly ImageAttachment[],
    configuration?: { provider: string; modelId: string; thinkingLevel: ThinkingLevel },
  ) {
    if (this.pending) return this.pending;
    if (!prompt.trim() && !images?.length) return Promise.reject(new Error("请输入消息"));
    if (!workspaceId) return Promise.reject(new Error("请先选择项目"));
    if (this.workspaceId && this.workspaceId !== workspaceId)
      return Promise.reject(new Error("已创建的会话不能切换项目"));
    this.pending = this.send(workspaceId, prompt.trim(), images, configuration).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async send(
    workspaceId: string,
    prompt: string,
    images?: readonly ImageAttachment[],
    configuration?: { provider: string; modelId: string; thinkingLevel: ThinkingLevel },
  ) {
    if (!this.threadId) {
      const created = await this.bridge.createThread(
        workspaceId,
        this.requestId,
        ...(configuration ? [configuration] : []),
      );
      this.threadId = created.id;
      this.workspaceId = workspaceId;
    }
    if (configuration)
      await this.bridge.configureThread?.(
        this.threadId,
        configuration.provider,
        configuration.modelId,
        configuration.thinkingLevel,
      );
    await this.bridge.submit(this.threadId, prompt, ...(images ? [images] : []));
    return this.threadId;
  }

  get persistedId() {
    return this.threadId;
  }
}

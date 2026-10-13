import type { CreateThreadConfiguration } from "@eta/core/agent/protocol";
import type { ImageAttachment } from "@eta/core/images/types";
import type { DesktopBridge } from "../../../src/bridge.ts";
import type { CreateWorktreeInput } from "@eta/core/service/git/worktrees";

type DraftBridge = Pick<DesktopBridge, "submit"> &
  Partial<Pick<DesktopBridge, "configureThread" | "configureSandbox" | "createWorktree">> & {
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
  private worktree?: { key: string; requestId: string; workspaceId?: string };

  constructor(
    readonly requestId: string,
    private readonly bridge: DraftBridge,
  ) {}

  submit(
    workspaceId: string | null,
    prompt: string,
    images?: readonly ImageAttachment[],
    configuration?: CreateThreadConfiguration,
    worktree?: Omit<CreateWorktreeInput, "requestId">,
  ) {
    if (this.pending) return this.pending;
    if (!prompt.trim() && !images?.length) return Promise.reject(new Error("请输入消息"));
    if (!workspaceId) return Promise.reject(new Error("请先选择项目"));
    if (
      this.workspaceId &&
      this.workspaceId !== workspaceId &&
      (!worktree ||
        this.worktree?.key !== JSON.stringify(worktree) ||
        this.worktree.workspaceId !== this.workspaceId)
    )
      return Promise.reject(new Error("已创建的会话不能切换项目"));
    this.pending = this.send(workspaceId, prompt.trim(), images, configuration, worktree).finally(
      () => {
        this.pending = undefined;
      },
    );
    return this.pending;
  }

  private async send(
    workspaceId: string,
    prompt: string,
    images?: readonly ImageAttachment[],
    configuration?: CreateThreadConfiguration,
    worktree?: Omit<CreateWorktreeInput, "requestId">,
  ) {
    if (worktree && !this.threadId) {
      if (!this.bridge.createWorktree) throw new Error("此执行环境不支持 worktree");
      const key = JSON.stringify(worktree);
      if (this.worktree?.key !== key) this.worktree = { key, requestId: crypto.randomUUID() };
      const receipt = this.worktree;
      if (!receipt.workspaceId) {
        const created = await this.bridge.createWorktree({
          ...worktree,
          requestId: receipt.requestId,
        });
        if (!created.workspaceId) throw new Error("worktree 尚未就绪，请稍后重试");
        receipt.workspaceId = created.workspaceId;
      }
      workspaceId = receipt.workspaceId;
    }
    if (this.threadId && this.workspaceId) workspaceId = this.workspaceId;
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
    if (configuration?.sandboxMode)
      await this.bridge.configureSandbox?.(this.threadId, configuration.sandboxMode);
    await this.bridge.submit(this.threadId, prompt, ...(images ? [images] : []));
    return this.threadId;
  }

  get persistedId() {
    return this.threadId;
  }

  get persistedWorkspaceId() {
    return this.workspaceId;
  }
}

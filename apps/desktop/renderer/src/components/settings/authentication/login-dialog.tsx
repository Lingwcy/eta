import { useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, KeyRound, X } from "lucide-react";
import type { LoginPrompt } from "../../../../../src/authentication.ts";
import type { useAuthentication } from "@/agent/use-authentication";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";

function LoginPromptForm({
  prompt,
  busy,
  onAnswer,
}: {
  prompt: LoginPrompt;
  busy: boolean;
  onAnswer: (id: string, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onAnswer(prompt.id, value);
        setValue("");
      }}
    >
      <label htmlFor={prompt.id} className="text-sm/6 font-medium text-neutral-800">
        {prompt.message}
      </label>
      {prompt.type === "select" ? (
        <Select
          label={prompt.message}
          value={value}
          onValueChange={setValue}
          options={(prompt.options ?? []).map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          disabled={busy}
        />
      ) : (
        <Input
          id={prompt.id}
          type={prompt.type === "secret" ? "password" : "text"}
          autoComplete="off"
          autoFocus
          value={value}
          onValueChange={setValue}
          placeholder={prompt.placeholder}
          disabled={busy}
        />
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || (prompt.type === "select" && !value)}>
          {busy ? "正在提交…" : "继续"}
        </Button>
      </div>
    </form>
  );
}

export function LoginDialog({
  auth,
  name,
}: {
  auth: ReturnType<typeof useAuthentication>;
  name: string;
}) {
  const login = auth.login;
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <Dialog
      open={!!login}
      onOpenChange={(open) => {
        if (!open) void auth.close();
      }}
    >
      <DialogContent variant="form">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-xl font-semibold text-neutral-900">
              连接 {name}
            </DialogTitle>
            <p className="mt-1 text-sm text-neutral-500">
              {login?.method === "oauth" ? "使用你的账户继续" : "配置 API Key 与服务访问参数"}
            </p>
          </div>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="关闭并取消登录"
            onClick={() => void auth.close()}
            disabled={auth.busy}
          >
            <X size={18} />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {auth.error && (
            <div className="mb-4">
              <Alert>{auth.error}</Alert>
            </div>
          )}
          {login?.status === "completed" ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <Check size={24} />
              </span>
              <p className="text-lg font-semibold">连接成功</p>
              <p className="text-sm text-neutral-500">模型已加入可用列表，可以开始聊天。</p>
              <Button onClick={() => void auth.close()}>完成</Button>
            </div>
          ) : login?.status === "failed" || login?.status === "cancelled" ? (
            <div className="flex flex-col gap-4">
              <Alert>{login.message}</Alert>
              <Button onClick={() => void auth.close()}>返回设置</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {login && (
                <p role="status" className="flex items-start gap-2 text-sm/6 text-neutral-500">
                  {login.prompt ? (
                    <KeyRound size={16} className="mt-1 shrink-0" />
                  ) : (
                    <LoaderCircle
                      size={16}
                      className="mt-1 shrink-0 animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {login.message}
                </p>
              )}
              {login?.deviceCode && (
                <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-4 py-3">
                  <code className="text-xl font-semibold tracking-[0.18em]">
                    {login.deviceCode}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="复制设备码"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(login.deviceCode ?? "")
                        .then(() => setCopied(login.id))
                        .catch(() => {})
                    }
                  >
                    {copied === login.id ? <Check size={16} /> : <Copy size={16} />}
                  </Button>
                </div>
              )}
              {login?.links.map((link) => (
                <div key={link.url} className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => void auth.openLink(link.url)}>
                    <ExternalLink size={15} />
                    {link.label ?? "打开授权链接"}
                  </Button>
                  <Button
                    variant="ghost-muted"
                    size="icon-sm"
                    aria-label="复制授权链接"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(link.url)
                        .then(() => setCopied(link.url))
                        .catch(() => {})
                    }
                  >
                    {copied === link.url ? <Check size={16} /> : <Copy size={16} />}
                  </Button>
                </div>
              ))}
              {login?.prompt && (
                <LoginPromptForm
                  key={login.prompt.id}
                  prompt={login.prompt}
                  busy={auth.busy}
                  onAnswer={auth.answer}
                />
              )}
              <p className="text-xs/5 text-neutral-400">
                凭据仅保存在此电脑。取消登录不会替换已保存的连接。
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

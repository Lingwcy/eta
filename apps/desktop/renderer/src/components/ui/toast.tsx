import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Button } from "./button";
import { localizedMessage, renderMessage, type Message } from "@/i18n/messages";

const Notices = createContext<Map<string, string> | null>(null);
const NoticeVisibility = createContext(true);
const defaultTitle = localizedMessage("common:toast.theActionCouldNotBeCompleted");

function LocalizedNotice({ message }: { message: Message }) {
  useTranslation();
  return renderMessage(message);
}

export function ToastScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parent = useContext(NoticeVisibility);
  return <NoticeVisibility.Provider value={active && parent}>{children}</NoticeVisibility.Provider>;
}

/** One application viewport, including notifications raised inside dialogs and hidden tabs. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const notices = useRef(new Map<string, string>());
  return (
    <Notices.Provider value={notices.current}>
      <Toast.Provider timeout={8000} limit={3}>
        {children}
        <ToastViewport />
      </Toast.Provider>
    </Notices.Provider>
  );
}

function ToastViewport() {
  useTranslation();
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport
        aria-label={t("common:toast.notifications")}
        className="pointer-events-none fixed top-14 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none"
      >
        {toasts.map((toast) => {
          const Icon =
            toast.type === "success" ? CircleCheck : toast.type === "info" ? Info : CircleAlert;
          return (
            <Toast.Root
              key={toast.id}
              toast={toast}
              swipeDirection="right"
              className="pointer-events-auto rounded-xl border border-neutral-200/80 bg-white p-3 text-neutral-800 shadow-lg shadow-black/8 transition-[opacity,translate] duration-200 ease-out data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0 data-limited:hidden motion-reduce:transition-none motion-reduce:data-starting-style:translate-x-0 motion-reduce:data-ending-style:translate-x-0"
            >
              <Toast.Content className="flex items-start gap-2.5">
                <Icon size={16} className="mt-0.5 shrink-0 text-neutral-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <Toast.Title className="text-xs font-medium" />
                  <Toast.Description className="mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-neutral-500" />
                  {toast.actionProps && (
                    <div className="mt-2">
                      <Toast.Action render={<Button variant="secondary" size="compact" />} />
                    </div>
                  )}
                </div>
                <Toast.Close
                  aria-label={t("common:toast.closeNotification")}
                  render={<Button variant="ghost-muted" size="icon-tiny" />}
                >
                  <X size={12} aria-hidden="true" />
                </Toast.Close>
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

/** Report each error episode once; background views wait until they become visible. */
export function ToastNotice({
  message,
  title = defaultTitle,
  type = "error",
  active = true,
  onRetry,
}: {
  message?: Message | null;
  title?: Message;
  type?: "error" | "success" | "info";
  active?: boolean;
  onRetry?: () => void;
}) {
  const manager = Toast.useToastManager();
  const notices = useContext(Notices);
  const visible = useContext(NoticeVisibility);
  const latest = useRef({ manager, onRetry });
  latest.current = { manager, onRetry };
  const shown = useRef<{ message: Message; key: string; id?: string } | undefined>(undefined);
  useEffect(() => {
    const { manager } = latest.current;
    const previous = shown.current;
    // A resolved or replaced condition must not leave its old notice on screen.
    if (!message || previous?.message !== message) {
      if (previous?.id) {
        manager.close(previous.id);
        if (notices?.get(previous.key) === previous.id) notices.delete(previous.key);
      }
      shown.current = undefined;
    }
    if (!message) return;
    if (!active || !visible || shown.current?.message === message) return;
    const key = `${type}:${JSON.stringify(message)}`;
    if (notices?.has(key)) {
      // Another view already reported this failure; do not take ownership of its notice.
      shown.current = { message, key };
      return;
    }
    const id = manager.add({
      title: <LocalizedNotice message={title} />,
      description: <LocalizedNotice message={message} />,
      type,
      onClose: () => notices?.delete(key),
      ...(latest.current.onRetry
        ? {
            actionProps: {
              children: <LocalizedNotice message={localizedMessage("common:toast.retry")} />,
              onClick: () => {
                manager.close(id);
                latest.current.onRetry?.();
              },
            },
          }
        : {}),
    });
    shown.current = { message, key, id };
    notices?.set(key, id);
  }, [message, title, type, active, visible, notices]);
  return null;
}

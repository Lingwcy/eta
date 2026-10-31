import { LocalizedError, describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { InputMode } from "@eta/core/agent/protocol";
import { Button } from "@/components/ui/button";
import { ImageAttachments, type AttachmentItem } from "./image-attachments";
import { extractImagePaths } from "./image-paths";
import type { ImageSource } from "@eta/core/images/types";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ActionToolbar } from "./action-toolbar";
import { PromptTextarea } from "./prompt-textarea";
import { ToastNotice } from "@/components/ui/toast";
import type { CompositeInputProps } from "./types";

export function CompositeInput({
  value,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = t("chat:compositeInput.placeholder"),
  disabled = false,
  submitDisabled = false,
  isRunning = false,
  allowSubmitWhileRunning = false,
  inputQueueSupported = false,
  queuedInputs = [],
  onWithdrawInput,
  className,
  cwd,
  ...toolbar
}: CompositeInputProps) {
  useTranslation();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachmentError, setAttachmentError] = useState<Message>();
  const [restoring, setRestoring] = useState<string>();
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const liveAttachments = useRef(new Set<string>());
  const sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      liveAttachments.current.clear();
    };
  }, []);
  const pending = attachments.some((item) => !item.image && !item.error);
  const failed = attachments.some((item) => item.error);
  const locked = disabled || submitting || (isRunning && !allowSubmitWhileRunning);
  const prepare = (source: ImageSource) =>
    window.eta.prepareImage(source, cwd, toolbar.model?.provider, toolbar.model?.id);
  const addFiles = async (files: File[]) => {
    if (locked) return;
    setAttachmentError(undefined);
    const queued = files.map((file) => ({ file, id: crypto.randomUUID() }));
    for (const { id } of queued) liveAttachments.current.add(id);
    setAttachments((items) => [
      ...items,
      ...queued.map(({ file, id }) => ({
        id,
        name: file.name || t("chat:compositeInput.pastedImage"),
      })),
    ]);
    for (const { file, id } of queued) {
      if (!mounted.current) return;
      // Each selection gets a fresh ID; removal invalidates its queued and in-flight work.
      const current = () => mounted.current && liveAttachments.current.has(id);
      if (!current()) continue;
      if (
        !file.type.startsWith("image/") &&
        !/\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(file.name)
      ) {
        setAttachmentError(
          localizedMessage("chat:compositeInput.onlyImageAttachmentsAreSupported"),
        );
        setAttachments((items) =>
          items.map((item) =>
            item.id === id
              ? { ...item, error: t("chat:compositeInput.onlyImageAttachmentsAreSupported") }
              : item,
          ),
        );
        continue;
      }
      try {
        if (file.size > 32 * 1024 * 1024)
          throw new LocalizedError("chat:compositeInput.theImageFileExceeds32Mib");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === "string"
              ? resolve(reader.result.split(",")[1])
              : reject(new LocalizedError("chat:compositeInput.cannotReadTheImage"));
          reader.onerror = () =>
            reject(new LocalizedError("chat:compositeInput.cannotReadTheImage"));
          reader.readAsDataURL(file);
        });
        if (!current()) continue;
        const source = { data, name: file.name || t("chat:compositeInput.pastedImagePng") };
        const image = await prepare(source);
        if (current())
          setAttachments((items) =>
            items.map((item) => (item.id === id ? { ...item, image, source } : item)),
          );
      } catch (error) {
        if (current()) {
          const message = describeError(
            error,
            localizedMessage("chat:compositeInput.imageProcessingFailed"),
          );
          setAttachmentError(message);
          setAttachments((items) =>
            items.map((item) => (item.id === id ? { ...item, error: message } : item)),
          );
        }
      }
    }
  };
  const text = value ?? internalValue;
  const latestText = useRef(text);
  latestText.current = text;
  const setText = (next: string) => {
    latestText.current = next;
    if (value === undefined) setInternalValue(next);
    onChange?.(next);
  };
  const handleSubmit = async (mode?: InputMode) => {
    if (
      (!text.trim() && !attachments.length) ||
      locked ||
      sending.current ||
      pending ||
      failed ||
      submitDisabled ||
      !onSubmit
    )
      return;
    sending.current = true;
    setSubmitting(true);
    setAttachmentError(undefined);
    try {
      const { prompt, paths } = extractImagePaths(text);
      const images = await Promise.all(
        attachments.flatMap((item) =>
          item.source ? [prepare(item.source)] : item.image ? [Promise.resolve(item.image)] : [],
        ),
      );
      for (const path of paths) images.push(await prepare({ path }));
      const maxPerMessage = toolbar.model?.inputLimits?.images?.maxPerMessage;
      if (maxPerMessage && images.length > maxPerMessage)
        throw new LocalizedError("chat:compositeInput.thisModelSupportsUpToImagesPer", {
          count: maxPerMessage,
        });
      if (inputQueueSupported)
        await onSubmit(
          prompt,
          images.length ? images : undefined,
          mode ?? (isRunning ? "steer" : "reject"),
        );
      else await onSubmit(prompt, images.length ? images : undefined);
      if (!mounted.current) return;
      if (latestText.current === text) setText("");
      liveAttachments.current.clear();
      setAttachments([]);
    } catch (error) {
      if (mounted.current)
        setAttachmentError(
          describeError(error, localizedMessage("chat:compositeInput.cannotSendTheMessage")),
        );
    } finally {
      sending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };
  const restoreInput = async (operationId: string) => {
    if (!onWithdrawInput || restoring) return;
    setRestoring(operationId);
    try {
      const result = await onWithdrawInput(operationId);
      if (!mounted.current) return;
      if (result.status === "already_placed" || result.prompt === undefined)
        throw new LocalizedError("chat:inputQueue.alreadyPlaced");
      setText([latestText.current, result.prompt].filter(Boolean).join("\n\n"));
      setAttachments((items) => [
        ...items,
        ...(result.images ?? []).map((image) => ({
          id: crypto.randomUUID(),
          name: image.name ?? "image.png",
          image,
        })),
      ]);
      setRestored((items) => new Set([...items, operationId]));
    } catch (error) {
      if (mounted.current)
        setAttachmentError(
          describeError(error, localizedMessage("chat:compositeInput.cannotSendTheMessage")),
        );
    } finally {
      if (mounted.current) setRestoring(undefined);
    }
  };
  return (
    <div
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length && !locked) {
          event.preventDefault();
          void addFiles(files);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files") && !locked) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
      className={cn(
        "relative flex w-full flex-col gap-3 rounded-[24px] bg-white p-4 shadow-[0_2px_6px_#00000006,0_1px_2px_#00000003] min-[701px]:px-5 min-[701px]:pt-5 min-[701px]:pb-3",
        dragging && "ring-2 ring-neutral-400",
        className,
      )}
    >
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {queuedInputs.some((input) => !restored.has(input.operationId)) && (
        <ul
          className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-neutral-500"
          aria-label={t("chat:inputQueue.pending")}
        >
          {queuedInputs
            .filter((input) => !restored.has(input.operationId))
            .map((input) => (
              <li key={input.operationId} className="flex min-h-7 items-center gap-2">
                <span className="shrink-0">
                  {t(
                    input.status === "cancelled"
                      ? "chat:inputQueue.cancelled"
                      : input.status === "failed"
                        ? "chat:inputQueue.failed"
                        : input.mode === "steer"
                          ? "chat:inputQueue.steering"
                          : "chat:inputQueue.following",
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate" title={input.prompt}>
                  {input.prompt ||
                    input.images.map((image) => image.name ?? image.mimeType).join(", ")}
                </span>
                <Button
                  variant="ghost-muted"
                  size="toolbar"
                  disabled={submitting || pending || toolbar.isStopping || !!restoring}
                  onClick={() => void restoreInput(input.operationId)}
                >
                  {t("chat:inputQueue.restore")}
                </Button>
              </li>
            ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <ImageAttachments
          items={attachments}
          disabled={locked}
          onRemove={(id) => {
            liveAttachments.current.delete(id);
            setAttachments((items) => items.filter((item) => item.id !== id));
            setAttachmentError(undefined);
          }}
        />
      )}
      <ToastNotice
        message={attachmentError}
        title={localizedMessage("chat:compositeInput.theAttachmentCouldNotBeAdded")}
      />
      <PromptTextarea
        value={text}
        onChange={setText}
        onSubmit={(mode) => {
          void handleSubmit(mode);
        }}
        allowFollowUp={inputQueueSupported}
        placeholder={placeholder}
        disabled={locked}
      />
      <ActionToolbar
        {...toolbar}
        onFollowUp={
          isRunning && inputQueueSupported ? () => void handleSubmit("followUp") : undefined
        }
        onAttach={() => picker.current?.click()}
        disabled={disabled || submitting}
        isRunning={isRunning}
        allowSubmitWhileRunning={allowSubmitWhileRunning}
        hasContent={Boolean(text.trim()) || attachments.length > 0}
        onSubmit={() => {
          void handleSubmit();
        }}
        canSubmit={
          !submitDisabled &&
          Boolean(onSubmit) &&
          (Boolean(text.trim()) || attachments.some((item) => item.image)) &&
          !pending &&
          !failed
        }
      />
    </div>
  );
}

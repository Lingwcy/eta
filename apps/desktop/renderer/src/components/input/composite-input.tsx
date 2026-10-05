import { ImageAttachments, type AttachmentItem } from "./image-attachments";
import { extractImagePaths } from "./image-paths";
import type { ImageSource } from "../../../../src/images/types.ts";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ActionToolbar } from "./action-toolbar";
import { PromptTextarea } from "./prompt-textarea";
import type { CompositeInputProps } from "./types";

export function CompositeInput({
  value,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = "Hi, what do you need today?",
  disabled = false,
  submitDisabled = false,
  isRunning = false,
  className,
  cwd,
  ...toolbar
}: CompositeInputProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = attachments.some((item) => !item.image && !item.error);
  const failed = attachments.some((item) => item.error);
  const locked = disabled || submitting || isRunning;
  const prepare = (source: ImageSource) =>
    window.eta.prepareImage(source, cwd, toolbar.model?.provider, toolbar.model?.id);
  const addFiles = async (files: File[]) => {
    if (locked) return;
    setAttachmentError(undefined);
    const queued = files.map((file) => ({ file, id: crypto.randomUUID() }));
    setAttachments((items) => [
      ...items,
      ...queued.map(({ file, id }) => ({ id, name: file.name || "粘贴图片" })),
    ]);
    for (const { file, id } of queued) {
      if (!mounted.current) return;
      if (
        !file.type.startsWith("image/") &&
        !/\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(file.name)
      ) {
        setAttachmentError("目前仅支持图片附件");
        setAttachments((items) =>
          items.map((item) => (item.id === id ? { ...item, error: "目前仅支持图片附件" } : item)),
        );
        continue;
      }
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error("图片文件超过 32 MiB");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === "string"
              ? resolve(reader.result.split(",")[1])
              : reject(new Error("无法读取图片"));
          reader.onerror = () => reject(new Error("无法读取图片"));
          reader.readAsDataURL(file);
        });
        const source = { data, name: file.name || "粘贴图片.png" };
        const image = await prepare(source);
        if (mounted.current)
          setAttachments((items) =>
            items.map((item) => (item.id === id ? { ...item, image, source } : item)),
          );
      } catch (error) {
        if (mounted.current) {
          const message = error instanceof Error ? error.message : "图片处理失败";
          setAttachmentError(message);
          setAttachments((items) =>
            items.map((item) => (item.id === id ? { ...item, error: message } : item)),
          );
        }
      }
    }
  };
  const text = value ?? internalValue;
  const setText = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onChange?.(next);
  };
  const handleSubmit = async () => {
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
        attachments.flatMap((item) => (item.source ? [prepare(item.source)] : [])),
      );
      for (const path of paths) images.push(await prepare({ path }));
      const maxPerMessage = toolbar.model?.inputLimits?.images?.maxPerMessage;
      if (maxPerMessage && images.length > maxPerMessage)
        throw new Error(`当前模型每条消息最多支持 ${maxPerMessage} 张图片`);
      await onSubmit(prompt, images.length ? images : undefined);
      setText("");
      setAttachments([]);
    } catch (error) {
      if (mounted.current)
        setAttachmentError(error instanceof Error ? error.message : "无法发送消息");
    } finally {
      sending.current = false;
      if (mounted.current) setSubmitting(false);
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
      {attachments.length > 0 && (
        <ImageAttachments
          items={attachments}
          disabled={locked}
          onRemove={(id) => {
            setAttachments((items) => items.filter((item) => item.id !== id));
            setAttachmentError(undefined);
          }}
        />
      )}
      {attachmentError && (
        <p role="alert" className="text-xs text-red-600">
          {attachmentError}
        </p>
      )}
      <PromptTextarea
        value={text}
        onChange={setText}
        onSubmit={() => {
          void handleSubmit();
        }}
        placeholder={placeholder}
        disabled={disabled || submitting || isRunning}
      />
      <ActionToolbar
        {...toolbar}
        onAttach={() => picker.current?.click()}
        disabled={disabled || submitting}
        isRunning={isRunning}
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

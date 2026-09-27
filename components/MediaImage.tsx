"use client";

/**
 * 正文图片渲染（M1-补丁1 C2）：BaLazyImage 并发限流 + 点击灯箱放大。
 * 服务端组件（文章详情页）与编辑器预览共用；URL 先过协议校验
 * （isSafeMediaUrl：站内绝对路径或 https），不安全/缺失直接渲染降级占位，
 * 不输出 img src——javascript:/data: 等危险协议没有任何到达 DOM 的路径。
 * 灯箱为零依赖自实现：遮罩 + 原图 + 点击/Esc 关闭（任务书 C2 允许）。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BaLazyImage } from "@/components/BaLazyImage";
import { isSafeMediaUrl } from "@/lib/media";

function MediaFallback({ message }: { message: string }) {
  return (
    <span
      role="note"
      className="my-4 flex items-center justify-center gap-2 rounded-md border border-dashed border-[color:rgb(var(--ba-line))] bg-[color:rgb(var(--ba-primary-soft))] px-4 py-5 text-sm text-slate-500 dark:text-slate-400"
    >
      <span aria-hidden>🖼️</span>
      {message}
    </span>
  );
}

function MediaLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "图片预览"}
      onClick={onClose}
      className="fixed inset-0 z-[9999] flex cursor-zoom-out items-center justify-center bg-black/85 p-4 sm:p-8"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-full rounded-md object-contain shadow-2xl"
      />
    </div>,
    document.body
  );
}

export function MediaImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!src || !isSafeMediaUrl(src)) {
    return <MediaFallback message="图片地址不可用" />;
  }
  return (
    <>
      {/* inline 模式：span 根节点，保证 img 组件可以合法出现在 <p> 段落内 */}
      <span className="block my-2">
        <BaLazyImage
          src={src}
          alt={alt ?? ""}
          inline
          className="mx-auto h-auto max-w-full cursor-zoom-in"
          onClick={() => setOpen(true)}
        />
      </span>
      {open && <MediaLightbox src={src} alt={alt ?? ""} onClose={close} />}
    </>
  );
}

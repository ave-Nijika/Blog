"use client";

/**
 * 正文图片渲染（M1-补丁1 C2 + M2-补丁2 D1 + M2-补丁3 B）：BaLazyImage
 * 并发限流 + 点击灯箱放大。默认加载 sharp 缩略图（thumbnailUrlFor 映射，
 * A2 惰性生成兜底），缩略图失败降级原图（A4 不 404）；灯箱始终加载原图。
 * URL 先过协议校验（isSafeMediaUrl），不安全/缺失渲染降级占位，
 * 不输出 img src——javascript:/data: 等危险协议没有任何到达 DOM 的路径。
 * 灯箱为零依赖自实现（遮罩 + 原图/视频 + 点击/Esc 关闭），导出供编辑器
 * NodeView 共享（M2-补丁2 B1/B2）。
 * M2-补丁4（主人实测裁决）：删除 M2-补丁3 的 fit⇄zoomed 点击缩放状态机
 * （存在明显缺陷且不需要）；灯箱回归"黑幕 + 适应窗口原图 + 关闭"最简形态。
 * 灯箱打开期间隐藏 ba-click-fx 特效层——其 contrastCanvas 为 mix-blend-mode:
 * darken，在灯箱黑幕（近纯黑）上 darken 取暗色，蓝色拖尾特效被混合吞掉，
 * 观感即"光标沉到图片和黑幕之下"。离开灯箱即恢复特效。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BaLazyImage } from "@/components/BaLazyImage";
import { isSafeMediaUrl, thumbnailUrlFor } from "@/lib/media";

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

export type MediaLightboxKind = "image" | "video";

/**
 * 零依赖媒体灯箱（共享组件）：遮罩 + 内容 + 点击/Esc 关闭。
 * kind=image：适应窗口的静态原图展示（M2-补丁4 按主人裁决移除点击缩放
 * 状态机）；点击图片外（遮罩）或 Esc 关闭。图片容器 stopPropagation——
 * 图片上的点击永不冒泡成"关闭"。
 * kind=video 渲染 <video controls autoPlay>（仅在灯箱打开时挂载——编辑区/
 * 正文默认零视频下载，M2-补丁2 B2），行为不变，仅同步遮罩层级（视频区域
 * stopPropagation 已有，遮罩不再带 zoom 光标——那是图片缩放语义）。
 */
export function MediaLightbox({
  src,
  alt,
  kind = "image",
  onClose,
}: {
  src: string;
  alt: string;
  kind?: MediaLightboxKind;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // M2-补丁4：隐藏 ba-click-fx 特效层（body 直属、aria-hidden、
    // z-index ≥ 2147483640 的 canvas 层）。其 darken 混合在灯箱黑幕上吞掉
    // 拖尾特效（主人观感"光标沉底"）；看图场景特效让位，关闭即恢复。
    const hiddenFx: HTMLElement[] = [];
    document.body
      .querySelectorAll<HTMLElement>(":scope > [aria-hidden='true']")
      .forEach((el) => {
        const z = Number.parseInt(el.style.zIndex || "0", 10);
        if (z >= 2147483640) {
          hiddenFx.push(el);
          el.style.display = "none";
        }
      });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      hiddenFx.forEach((el) => (el.style.display = ""));
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "媒体预览"}
      onClick={onClose}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-4 sm:p-8"
    >
      {kind === "video" ? (
        // 点击遮罩关闭与视频交互冲突：阻止冒泡，关闭走右上按钮/Esc
        <span className="relative flex max-h-[90vh] max-w-full items-center" onClick={(e) => e.stopPropagation()}>
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[85vh] max-w-full rounded-md shadow-2xl"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            className="absolute -top-2 right-0 -translate-y-full rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-slate-700 shadow hover:bg-white"
          >
            ✕ 关闭
          </button>
        </span>
      ) : (
        <div onClick={(e) => e.stopPropagation()} className="flex max-h-full max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="max-h-[90vh] max-w-full rounded-md object-contain shadow-2xl"
          />
        </div>
      )}
    </div>,
    document.body
  );
}

export function MediaImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  // D1/A4：默认缩略图；加载失败（如 sharp 无法处理的历史图）降级原图
  const [thumbFailed, setThumbFailed] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!src || !isSafeMediaUrl(src)) {
    return <MediaFallback message="图片地址不可用" />;
  }
  const thumb = thumbFailed ? null : thumbnailUrlFor(src);
  return (
    <>
      {/* inline 模式：span 根节点，保证 img 组件可以合法出现在 <p> 段落内 */}
      <span className="block my-2">
        <BaLazyImage
          src={thumb ?? src}
          alt={alt ?? ""}
          inline
          className="mx-auto h-auto max-w-full cursor-zoom-in"
          onClick={() => setOpen(true)}
          onLoadError={thumb ? () => setThumbFailed(true) : undefined}
        />
      </span>
      {open && <MediaLightbox src={src} alt={alt ?? ""} onClose={close} />}
    </>
  );
}

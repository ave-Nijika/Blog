"use client";

/**
 * 正文图片渲染（M1-补丁1 C2 + M2-补丁2 D1 + M2-补丁3 B）：BaLazyImage
 * 并发限流 + 点击灯箱放大。默认加载 sharp 缩略图（thumbnailUrlFor 映射，
 * A2 惰性生成兜底），缩略图失败降级原图（A4 不 404）；灯箱始终加载原图。
 * URL 先过协议校验（isSafeMediaUrl），不安全/缺失渲染降级占位，
 * 不输出 img src——javascript:/data: 等危险协议没有任何到达 DOM 的路径。
 * 灯箱为零依赖自实现（遮罩 + 原图/视频 + 点击/Esc 关闭），导出供编辑器
 * NodeView 共享（M2-补丁2 B1/B2）。M2-补丁3：图片点击在 fit（适应窗口）
 * ⇄ zoomed（原始像素，容器可滚动/可拖拽平移）间切换，光标 zoom-in/zoom-out
 * 随态切换——光标样式直接挂在 img 上（img 是最上层的点击目标，此前挂在
 * 遮罩上被 img 覆盖，主人看到"光标在图片下面"即此因）。
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

/** 拖拽平移判定阈值：位移超过该值视为拖拽（抑制随后的 click 缩放切换） */
const DRAG_THRESHOLD_PX = 4;

/**
 * 零依赖媒体灯箱（共享组件）：遮罩 + 内容 + 点击/Esc 关闭。
 * kind=image：点击图片在 fit（适应窗口，cursor-zoom-in）⇄ zoomed（原始
 * 像素尺寸，容器可滚动、可按住拖拽平移，cursor-zoom-out）间切换；点击
 * 图片外（遮罩）或 Esc 关闭。图片容器 stopPropagation——图片上的点击只
 * 切换缩放，永不冒泡成"关闭"。
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
  // 状态机：fit（适应窗口）⇄ zoomed（原始像素）⇄ 关闭（组件卸载）
  const [zoomed, setZoomed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

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

  // zoomed 态拖拽平移：按住图片拖动 = 滚动容器（原生滚动位移动画零依赖）。
  // 与点击切换的边界：位移超阈值标记 moved，mouseup 后的 click 被抑制一次。
  useEffect(() => {
    if (!zoomed) return;
    const onMove = (e: MouseEvent) => {
      const pan = panRef.current;
      const el = scrollRef.current;
      if (!pan || !el) return;
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
        pan.moved = true;
      }
      el.scrollLeft = pan.scrollLeft - dx;
      el.scrollTop = pan.scrollTop - dy;
    };
    const onUp = () => {
      if (panRef.current?.moved) suppressClickRef.current = true;
      panRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [zoomed]);

  const handleImgClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false; // 拖拽平移结束，吞掉本次 click
      return;
    }
    setZoomed((v) => !v);
  }, []);

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
        <div
          ref={scrollRef}
          onClick={(e) => e.stopPropagation()}
          className={
            zoomed
              ? "flex max-h-full max-w-full overflow-auto"
              : "flex max-h-full max-w-full"
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            onClick={handleImgClick}
            onMouseDown={
              zoomed
                ? (e) => {
                    const el = scrollRef.current;
                    if (!el) return;
                    panRef.current = {
                      startX: e.clientX,
                      startY: e.clientY,
                      scrollLeft: el.scrollLeft,
                      scrollTop: el.scrollTop,
                      moved: false,
                    };
                  }
                : undefined
            }
            className={
              zoomed
                ? // 原始像素：不限制宽高；m-auto 在 flex 滚动容器内溢出安全
                  //（内容大于容器时 auto margin 落 0，从左上起可滚动，不裁剪）
                  "m-auto max-w-none cursor-zoom-out select-none"
                : "max-h-[90vh] max-w-full cursor-zoom-in rounded-md object-contain shadow-2xl"
            }
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

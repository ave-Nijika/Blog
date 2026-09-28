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
 * M2-补丁5：灯箱 blur-up 秒开——打开瞬间渲染浏览器已缓存的 w1600 缩略图
 * （blur 弱化），原图后台 fetch（AbortController 可中断）就绪后淡入替换，
 * 消除点击放大的白屏等待；加载中随时可关（abort，见 BlurPhase 状态机）。
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
 * blur-up 状态机（M2-补丁5 A）：
 *   thumb   —— 打开瞬间：仅渲染 w1600 缩略图（浏览器已缓存，零网络等待），
 *              blur(8px)+scale(1.02) 弱化像素感；后台 fetch 原图中
 *   cross   —— 原图 blob 就绪并 onload：原图层叠在缩略图上方淡入（300ms），
 *              观感即"模糊图逐渐变清晰"
 *   done    —— 淡入完成：模糊层 visibility 隐藏（视觉移除；元素保留撑位，
 *              避免原图固有尺寸大于缩略图时的布局跳动）
 *   failed  —— 原图 fetch 失败：保留缩略图模糊态不白屏（console.warn）
 *   direct  —— 无缩略图可用（外链 / 缩略图加载失败）：原图直出（现状行为）
 * 原图 fetch 带 AbortController：灯箱关闭/卸载即 abort（绝无"加载中出不去"）；
 * objectURL 用后 revoke。已缓存缩略图 + 小体积原图（M2-补丁5 上传压缩）共同
 * 保证"点开放大无等待感"。
 */
type BlurPhase = "thumb" | "cross" | "done" | "failed" | "direct";

/** cross 淡入时长（ms，与 transition-opacity duration-300 对应）+ 渲染余量 */
const CROSSFADE_MS = 340;

/**
 * 零依赖媒体灯箱（共享组件）：遮罩 + 内容 + 点击/Esc 关闭。
 * kind=image：blur-up 秒开（见上方状态机）后的静态原图展示（M2-补丁4 按主人
 * 裁决移除点击缩放状态机，不恢复）；点击图片外（遮罩）或 Esc 关闭。图片容器
 * stopPropagation——图片上的点击永不冒泡成"关闭"。
 * kind=video 渲染 <video controls autoPlay>（仅在灯箱打开时挂载——编辑区/
 * 正文默认零视频下载，M2-补丁2 B2），行为不变，无 blur-up。
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
  // M2-补丁5 A1：w1600 缩略图已被浏览器缓存（正文/编辑区正在显示），打开
  // 灯箱瞬间零等待可见；外链等无缩略图映射的 src 走 direct 原图直出
  const thumbUrl = kind === "image" ? thumbnailUrlFor(src) : null;
  const [phase, setPhase] = useState<BlurPhase>(thumbUrl ? "thumb" : "direct");
  const [origUrl, setOrigUrl] = useState<string | null>(null);
  const crossTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  // M2-补丁5 A2：后台 fetch 原图（AbortController 可中断）。关闭/卸载即
  // abort；blob 经 objectURL 交给 <img>（CSP img-src blob: 已由凛放行）。
  useEffect(() => {
    if (kind !== "image" || !thumbUrl) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(src, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setOrigUrl(objectUrl);
      } catch (error) {
        if (cancelled || (error as Error)?.name === "AbortError") return;
        // A3：保留缩略图模糊态不白屏
        console.warn("[lightbox] original image failed, keeping blur-up thumb:", error);
        setPhase((p) => (p === "thumb" ? "failed" : p));
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      abortRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (crossTimerRef.current !== null) {
        window.clearTimeout(crossTimerRef.current);
        crossTimerRef.current = null;
      }
    };
  }, [src, kind, thumbUrl]);

  const handleOriginalLoad = useCallback(() => {
    setPhase((p) => (p === "thumb" ? "cross" : p));
    if (crossTimerRef.current !== null) window.clearTimeout(crossTimerRef.current);
    crossTimerRef.current = window.setTimeout(() => {
      crossTimerRef.current = null;
      setPhase("done");
    }, CROSSFADE_MS);
  }, []);

  // 缩略图加载失败（惰性生成失败等罕见路径）：中止原图 fetch，原图直出
  const handleThumbError = useCallback(() => {
    abortRef.current?.abort();
    setPhase("direct");
  }, []);

  const showThumb = kind === "image" && thumbUrl !== null && phase !== "direct";

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
        <div onClick={(e) => e.stopPropagation()} className="relative flex max-h-[90vh] max-w-full">
          {showThumb ? (
            // 缩略图模糊层：正常流撑起显示框（缩略图已被浏览器缓存，零等待）；
            // done 后 visibility 隐藏（视觉移除，元素保留避免布局跳动）
            // eslint-disable-next-line @next/next/no-img-element
            <img
              data-testid="lightbox-thumb"
              src={thumbUrl}
              alt=""
              aria-hidden
              draggable={false}
              onError={handleThumbError}
              className={
                "max-h-[90vh] max-w-full rounded-md object-contain shadow-2xl " +
                "blur-[8px] scale-[1.02] " +
                (phase === "done" ? "invisible" : "")
              }
            />
          ) : null}
          {phase === "direct" ? (
            // 无缩略图可用：原图直出（外链 / 缩略图加载失败的降级路径）
            // eslint-disable-next-line @next/next/no-img-element
            <img
              data-testid="lightbox-original"
              src={src}
              alt={alt}
              draggable={false}
              className="max-h-[90vh] max-w-full rounded-md object-contain shadow-2xl"
            />
          ) : null}
          {origUrl ? (
            // 原图层：blob 就绪后渲染，onload 后叠在缩略图上方淡入（cross）
            // eslint-disable-next-line @next/next/no-img-element
            <img
              data-testid="lightbox-original"
              src={origUrl}
              alt={alt}
              draggable={false}
              onLoad={handleOriginalLoad}
              className={
                "absolute inset-0 h-full w-full object-contain transition-opacity duration-300 " +
                (phase === "thumb" ? "opacity-0" : "opacity-100")
              }
            />
          ) : null}
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

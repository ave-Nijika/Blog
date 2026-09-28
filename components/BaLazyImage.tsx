"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * 图片并发限制器（模块级，跨组件共享）。
 * 背景（主人实测：ComfyUI 瀑布墙灾难性卡顿）：同一源并发 <img> 请求占满浏览器
 * 同源连接池（HTTP/1.1 通常 6 条），站内 RSC 导航请求排在图片流之后 → 点击导航
 * 要等数秒~十几秒；DELETE 亦被排队 → "删除卡死整页"。
 * 全局并发槽保证任意时刻最多 2 张图片在下载，其余排队；导航请求始终有连接可用。
 */
const MAX_CONCURRENT = 2;

const queue: Array<(release: () => void) => void> = [];
let active = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    active += 1;
    const run = queue.shift();
    if (!run) break;
    const release = () => {
      active -= 1;
      pump();
    };
    run(release);
  }
}

/** 排队拿并发槽；轮到时以 release 回调执行 run（用完必须调用 release）。 */
function acquire(run: (release: () => void) => void): void {
  queue.push(run);
  pump();
}

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  onClick?: () => void;
  /**
   * 行内模式（M1-补丁1）：根节点与骨架占位改用 <span>（display:block）。
   * 正文 markdown 的图片常位于 <p> 段落内部，块级 <div> 进 <p> 会被浏览器
   * HTML 解析器强制断开，造成 hydration mismatch——服务端渲染的内容不受
   * 客户端重渲染影响但结构必须合法。默认 false，瀑布墙等既有用法零影响。
   */
  inline?: boolean;
  /**
   * 加载失败回调（M2-补丁2 D1/A4：缩略图降级原图用）。BaLazyImage 内部
   * onError 仍照常撤骨架；本回调供调用方切换 src。
   */
  onLoadError?: () => void;
}

/**
 * 并发受控 + 视口懒加载图片（BA 骨架占位 + 淡入）。
 * 仅用于列表/瀑布墙等非首屏图片；用户主动点击（灯箱）不受限流。
 * 卸载时若仍占着槽位则归还，避免槽位泄漏。
 */
export function BaLazyImage({
  src,
  alt,
  className,
  onClick,
  inline = false,
  onLoadError,
}: LazyImageProps) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const holder = useRef<HTMLDivElement | HTMLSpanElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el || shouldLoad) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          acquire((release) => {
            releaseRef.current = release;
            setShouldLoad(true);
          });
        }
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      // 组件卸载时仍持槽未加载完成 → 归还槽位
      if (releaseRef.current) {
        releaseRef.current();
        releaseRef.current = null;
      }
    };
  }, [shouldLoad]);

  const releaseSlot = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  // span 进 <p> 合法（phrasing content）；display:block 保持块状占位表现
  const content: ReactNode = (
    <>
      {!loaded && (
        <span
          className="absolute inset-0 animate-pulse bg-[color:rgb(var(--ba-primary-soft))] dark:bg-slate-800"
          aria-hidden
        />
      )}
      {shouldLoad ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          decoding="async"
          fetchPriority="low"
          onLoad={() => {
            releaseSlot();
            setLoaded(true);
          }}
          onError={() => {
            releaseSlot();
            setLoaded(true); // 失败也撤骨架，避免永久占位
            onLoadError?.(); // M2-补丁2：缩略图降级原图（调用方切换 src）
          }}
          onClick={onClick}
          className={`${className ?? ""} transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      ) : (
        <button
          type="button"
          aria-label={alt}
          onClick={onClick}
          className="absolute inset-0 h-full w-full cursor-pointer"
        />
      )}
    </>
  );

  if (inline) {
    return (
      <span ref={holder as RefObject<HTMLSpanElement>} className="relative block">
        {content}
      </span>
    );
  }
  return (
    <div ref={holder as RefObject<HTMLDivElement>} className="relative h-full w-full">
      {content}
    </div>
  );
}

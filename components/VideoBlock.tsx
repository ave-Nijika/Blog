"use client";

/**
 * 正文视频渲染（M1-补丁1 C3）：受控 <video controls preload="none">。
 * 视频语法 @video[alt](url) 在渲染前被 renderVideoSyntax 预处理成标准图片
 * 语法（lib/media.ts），由共享 components.img 按扩展名分流到这里——
 * 不走 rehype-raw、没有任何 HTML 字符串注入路径。
 * URL 协议校验与图片同规（isSafeMediaUrl）；加载失败显示降级占位。
 * <video> 属 phrasing content，可合法出现在 <p> 段落内，无需行内包装。
 */
import { useState } from "react";
import { isSafeMediaUrl } from "@/lib/media";

export function VideoBlock({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || !isSafeMediaUrl(src)) {
    return (
      <span
        role="note"
        className="my-4 flex items-center justify-center gap-2 rounded-md border border-dashed border-[color:rgb(var(--ba-line))] bg-[color:rgb(var(--ba-primary-soft))] px-4 py-5 text-sm text-slate-500 dark:text-slate-400"
      >
        <span aria-hidden>🎬</span>
        视频地址不可用
      </span>
    );
  }
  if (failed) {
    return (
      <span
        role="note"
        className="my-4 flex items-center justify-center gap-2 rounded-md border border-dashed border-[color:rgb(var(--ba-line))] bg-[color:rgb(var(--ba-primary-soft))] px-4 py-5 text-sm text-slate-500 dark:text-slate-400"
      >
        <span aria-hidden>🎬</span>
        视频加载失败：{alt || "视频"}
      </span>
    );
  }
  return (
    <video
      controls
      preload="none"
      src={src}
      aria-label={alt || undefined}
      onError={() => setFailed(true)}
      className="my-2 w-full rounded-md border border-[color:rgb(var(--ba-line))] bg-slate-100 shadow-md dark:bg-slate-800"
    />
  );
}

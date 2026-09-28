"use client";

/**
 * Tiptap NodeView 组件（M2-补丁1 A2 + M2-补丁2 B1-B4 重做）。
 * 全部 React 渲染——E4 红线：无任何 innerHTML/HTML 字符串拼接路径。
 *
 * M2-补丁2 变化：
 *   - 图片：默认加载 sharp 缩略图（thumbnailUrlFor 映射，失败 onError 降级
 *     原图），CSS 限高 220px，lazy/async；双击打开灯箱看原图（B1）。
 *     灯箱复用 components/MediaImage 的共享 MediaLightbox。
 *   - 视频：默认纯封面块（暗底 + 图标 + 文件名标注，零视频内容下载——
 *     红线 5，封面不含 <video> 元素）；悬停浮现播放按钮，点击打开灯箱
 *     <video controls autoPlay> 播放（B2）。
 *   - 悬停删除（B3/B4）：悬停媒体块浮现「仅从文章移除」「移除并删除文件」
 *     两个操作，取代叉叉+确认框；后者调 DELETE /api/admin/media（带
 *     excludeArticleId），409 → 仅移除节点并提示，失败保留节点并提示。
 *
 * 拖拽边界（B6）：拖拽由 NodeViewWrapper 的 data-drag-handle 承担（PM 仅在
 * 实际 dragstart——按下后产生位移——时激活）；单击/双击/悬停按钮无位移，
 * 与拖拽天然互斥，故互不抢占。
 */
import { useCallback, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { MediaLightbox } from "@/components/MediaImage";
import { thumbnailUrlFor } from "@/lib/media";
import {
  deleteMediaFileByApi,
  useMediaActions,
} from "./media-actions";

type ImageAttrs = {
  src: string | null;
  alt: string | null;
  linkHref: string | null;
  uploading: boolean;
};

/** B3：悬停删除动作条（图片/视频共用） */
function MediaHoverActions({
  url,
  onRemoveOnly,
  onRemoveAndDelete,
}: {
  url: string;
  onRemoveOnly: () => void;
  onRemoveAndDelete: () => void;
}) {
  return (
    <span
      className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        draggable={false}
        onClick={onRemoveOnly}
        title="仅从文章移除（服务器文件保留，可在媒体管理页清理）"
        aria-label={`仅从文章移除 ${url}`}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs font-medium text-white shadow transition-colors hover:bg-slate-700"
      >
        ✕
      </button>
      <button
        type="button"
        draggable={false}
        onClick={onRemoveAndDelete}
        title="从文章移除并删除服务器文件（仍被其他文章引用时仅从本文移除）"
        aria-label={`移除并删除文件 ${url}`}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-600/90 text-xs font-medium text-white shadow transition-colors hover:bg-rose-700"
      >
        🗑
      </button>
    </span>
  );
}

/** B3：悬停删除动作的共享行为（节点移除 + 文件删除 + 409/失败提示） */
function useMediaNodeActions(url: string, deleteNode: () => void) {
  const { articleId, onNotify } = useMediaActions();
  const [deleting, setDeleting] = useState(false);

  const removeOnly = useCallback(() => {
    deleteNode();
  }, [deleteNode]);

  const removeAndDeleteFile = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const result = await deleteMediaFileByApi(url, articleId);
      if (result.ok) {
        deleteNode(); // 200：文件已删，节点同步移除
        return;
      }
      if (result.referencedBy != null) {
        // 409：被其他文章引用 → 仅移除本文节点，文件保留（B3 语义）
        deleteNode();
        onNotify(
          `该文件仍被其他 ${result.referencedBy} 处文章内容引用，已仅从本文移除（文件保留）`
        );
        return;
      }
      onNotify(`删除失败：${result.error || "请稍后重试"}（媒体保留）`);
    } catch {
      onNotify("删除失败：网络异常，请重试（媒体保留）");
    } finally {
      setDeleting(false);
    }
  }, [articleId, deleteNode, deleting, onNotify, url]);

  return { removeOnly, removeAndDeleteFile, deleting };
}

export function EditorImageView(props: ReactNodeViewProps) {
  const { selected, node, editor, deleteNode } = props;
  const attrs = node.attrs as ImageAttrs;
  // A4：缩略图加载失败 → 降级原图（不 404）
  const [thumbFailed, setThumbFailed] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const url = attrs.src ?? "";
  const thumb = thumbFailed ? null : thumbnailUrlFor(url);
  const { removeOnly, removeAndDeleteFile, deleting } = useMediaNodeActions(
    url,
    deleteNode
  );

  // 灯箱/删除交互仅在可编辑状态有意义；关闭编辑（预览形态）走纯展示
  const interactive = editor.isEditable;

  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={(interactive && thumb) || url}
      alt={attrs.alt ?? ""}
      draggable={false}
      loading="lazy"
      decoding="async"
      onDoubleClick={
        interactive
          ? () => {
              setThumbFailed(false);
              setLightbox(true);
            }
          : undefined
      }
      onError={() => setThumbFailed(true)}
      className={
        "block h-auto max-w-full rounded-md border transition-shadow " +
        "max-h-[220px] " +
        (selected
          ? "border-[rgb(var(--ba-primary))] ring-2 ring-[rgb(var(--ba-primary))]/50"
          : "border-[color:rgb(var(--ba-line))]") +
        " " +
        (attrs.uploading ? "opacity-50" : "") +
        (interactive && !attrs.uploading ? " cursor-zoom-in" : "")
      }
    />
  );

  return (
    <NodeViewWrapper
      as="span"
      className="group relative inline-block align-middle"
      data-drag-handle=""
    >
      {attrs.uploading ? (
        <span className="flex items-center gap-2 rounded-md border border-dashed border-[color:rgb(var(--ba-line))] bg-[color:rgb(var(--ba-primary-soft))] px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" aria-hidden />
          上传中：{attrs.alt || "图片"}
        </span>
      ) : attrs.linkHref ? (
        <a
          href={editor.isEditable ? undefined : attrs.linkHref}
          title={attrs.alt ?? undefined}
          onClick={(e) => {
            if (editor.isEditable) e.preventDefault();
          }}
        >
          {img}
        </a>
      ) : (
        img
      )}
      {interactive && !attrs.uploading && url ? (
        <MediaHoverActions
          url={url}
          onRemoveOnly={removeOnly}
          onRemoveAndDelete={() => void removeAndDeleteFile()}
        />
      ) : null}
      {lightbox && url ? (
        <MediaLightbox src={url} alt={attrs.alt ?? ""} onClose={() => setLightbox(false)} />
      ) : null}
      {deleting ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md bg-white/50 dark:bg-slate-900/50"
        />
      ) : null}
    </NodeViewWrapper>
  );
}

type VideoAttrs = {
  alt: string | null;
  url: string;
  uploading: boolean;
};

export function EditorVideoView(props: ReactNodeViewProps) {
  const { selected, node, deleteNode } = props;
  const attrs = node.attrs as VideoAttrs;
  const [playing, setPlaying] = useState(false);
  const url = attrs.url;
  const { removeOnly, removeAndDeleteFile, deleting } = useMediaNodeActions(
    url,
    deleteNode
  );
  const fileName = url.split("/").pop() || url;

  return (
    <NodeViewWrapper
      as="span"
      className="group relative inline-block align-middle"
      data-drag-handle=""
    >
      {attrs.uploading ? (
        <span
          className={
            "flex min-w-[16rem] max-w-full items-center gap-3 rounded-md border px-3 py-2.5 " +
            (selected
              ? "border-[rgb(var(--ba-primary))] ring-2 ring-[rgb(var(--ba-primary))]/50"
              : "border-[color:rgb(var(--ba-line))] bg-[color:rgb(var(--ba-primary-soft))]")
          }
        >
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" aria-hidden />
          <span className="text-sm text-slate-500 dark:text-slate-400">
            上传中：{attrs.alt || "视频"}
          </span>
        </span>
      ) : (
        // B2：纯封面块——不渲染 <video>，编辑区零视频内容下载（红线 5）
        <span
          className={
            "flex min-w-[16rem] max-w-full items-center gap-3 rounded-md border px-3 py-2.5 transition-shadow " +
            (selected
              ? "border-[rgb(var(--ba-primary))] ring-2 ring-[rgb(var(--ba-primary))]/50"
              : "border-[color:rgb(var(--ba-line))] bg-slate-900/90") +
            " " +
            (deleting ? "opacity-60" : "")
          }
        >
          <span aria-hidden className="text-xl">🎬</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-100">
              {attrs.alt || "视频"}
            </span>
            <span className="block truncate text-xs text-slate-400">{fileName}</span>
          </span>
          {/* 悬停浮现播放按钮（B2）：点击开灯箱 <video controls autoPlay> */}
          <button
            type="button"
            draggable={false}
            onClick={() => setPlaying(true)}
            title="播放视频（灯箱放大播放）"
            aria-label={`播放视频 ${attrs.alt || fileName}`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/30"
          >
            ▶
          </button>
        </span>
      )}
      {!attrs.uploading && url ? (
        <MediaHoverActions
          url={url}
          onRemoveOnly={removeOnly}
          onRemoveAndDelete={() => void removeAndDeleteFile()}
        />
      ) : null}
      {/* 灯箱打开时才挂载 <video>——autoPlay 仅发生在主人主动点击之后 */}
      {playing && url ? (
        <MediaLightbox
          src={url}
          alt={attrs.alt ?? ""}
          kind="video"
          onClose={() => setPlaying(false)}
        />
      ) : null}
      {deleting ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md bg-white/30 dark:bg-slate-900/40"
        />
      ) : null}
    </NodeViewWrapper>
  );
}

type RawAttrs = {
  source: string;
  kind: string;
};

export function EditorRawView(props: ReactNodeViewProps) {
  const { selected, node } = props;
  const attrs = node.attrs as RawAttrs;
  return (
    <NodeViewWrapper className="my-2 block">
      <pre
        className={
          "overflow-x-auto rounded-md border bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-600 dark:bg-slate-900 dark:text-slate-300 " +
          (selected
            ? "border-[rgb(var(--ba-primary))] ring-2 ring-[rgb(var(--ba-primary))]/50"
            : "border-[color:rgb(var(--ba-line))]")
        }
      >
        {attrs.kind === "table" ? "【表格（编辑器内以源码显示）】\n" : ""}
        {attrs.source}
      </pre>
    </NodeViewWrapper>
  );
}

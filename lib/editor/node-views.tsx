"use client";

/**
 * Tiptap NodeView 组件（M2-补丁1 A2，全部 React 渲染——E4 红线：无任何
 * innerHTML/HTML 字符串拼接路径）。图片缩略图直出、视频封面块、raw 块。
 * selected 由 NodeView props 注入（选中高亮）；拖拽手柄交给 ProseMirror
 * 原生 node dragging（节点 spec draggable: true）。
 */
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

type ImageAttrs = {
  src: string | null;
  alt: string | null;
  linkHref: string | null;
  uploading: boolean;
};

export function EditorImageView(props: ReactNodeViewProps) {
  const { selected, node, editor } = props;
  const attrs = node.attrs as ImageAttrs;
  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={attrs.src ?? ""}
      alt={attrs.alt ?? ""}
      draggable={false}
      className={
        "block max-w-full rounded-md border transition-shadow " +
        (selected
          ? "border-[rgb(var(--ba-primary))] ring-2 ring-[rgb(var(--ba-primary))]/50"
          : "border-[color:rgb(var(--ba-line))]") +
        " " +
        (attrs.uploading ? "opacity-50" : "")
      }
    />
  );
  return (
    <NodeViewWrapper
      as="span"
      className={"inline-block align-middle " + (selected ? "relative" : "")}
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
    </NodeViewWrapper>
  );
}

type VideoAttrs = {
  alt: string | null;
  url: string;
  uploading: boolean;
};

export function EditorVideoView(props: ReactNodeViewProps) {
  const { selected, node } = props;
  const attrs = node.attrs as VideoAttrs;
  return (
    <NodeViewWrapper
      as="span"
      className="inline-block align-middle"
      data-drag-handle=""
    >
      <span
        className={
          "flex min-w-[16rem] max-w-full items-center gap-3 rounded-md border px-3 py-2.5 transition-shadow " +
          (selected
            ? "border-[rgb(var(--ba-primary))] ring-2 ring-[rgb(var(--ba-primary))]/50"
            : "border-[color:rgb(var(--ba-line))] bg-[color:rgb(var(--ba-primary-soft))]") +
          " " +
          (attrs.uploading ? "opacity-60" : "")
        }
      >
        {attrs.uploading ? (
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" aria-hidden />
        ) : (
          <span aria-hidden className="text-xl">🎬</span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-slate-700 dark:text-slate-200">
            {attrs.uploading ? `上传中：${attrs.alt || "视频"}` : attrs.alt || "视频"}
          </span>
          {!attrs.uploading && (
            <span className="block truncate text-xs text-slate-400 dark:text-slate-500">
              {attrs.url}
            </span>
          )}
        </span>
        <span aria-hidden className="ml-1 shrink-0 text-xs text-slate-400 dark:text-slate-500">
          ▶ 播放见预览
        </span>
      </span>
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

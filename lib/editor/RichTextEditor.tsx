"use client";

/**
 * Tiptap 富文本编辑器（M2-补丁1 A/B）。
 *
 * 双形态中的"富文本"形态：编辑区直接渲染图片缩略图/视频封面（NodeView），
 * 原生 ProseMirror 拖拽重排媒体块（dropcursor 视觉反馈），选中媒体浮现
 * BubbleMenu（改 alt / 替换文件 / 复制 URL / 彻底删除）。
 *
 * 数据流（生命线 1）：content 只在本组件挂载时由 initialBody 解析一次；
 * 此后 onUpdate → serializeDocToMarkdown → onBodyChange 单向流出；
 * 外部改动（源码模式切换、媒体面板移动/移除）经 registerSync 注册的
 * 同步函数回灌。双向不同步循环：外部回灌用 emitUpdate=false。
 *
 * 上传（A4）：粘贴/拖入文件 → 插入占位节点（uploading=true，NodeView 转圈）
 * → POST /api/admin/upload → updateAttributes 写入真实 URL；失败移除占位并
 * onNotify，不静默。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BubbleMenu, EditorContent, useEditor, type Editor } from "@tiptap/react";
import { fetchWithCsrf } from "@/lib/fetchWithCsrf";
import {
  altFromFileName,
  fileExtensionOf,
  mediaKindByExtension,
} from "@/lib/media";
import { buildEditorExtensions } from "./extensions";
import { MediaActionsContext } from "./media-actions";
import { markdownToEditorJson, serializeDocToMarkdown } from "./markdown";

type Props = {
  initialBody: string;
  onBodyChange: (md: string) => void;
  /** 外部 body 变更（面板/模式切换）回灌编辑器的同步函数注册 */
  registerSync: (fn: (md: string) => void) => void;
  /** 当前文章 id（编辑模式；新建为 undefined）——彻底删除的 excludeArticleId */
  articleId: string | undefined;
  onNotify: (message: string) => void;
};

async function uploadMediaFile(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetchWithCsrf("/api/admin/upload", {
    method: "POST",
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    url?: string;
    error?: string;
  };
  if (!res.ok || !data.ok || !data.url) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data.url;
}

export function RichTextEditor({
  initialBody,
  onBodyChange,
  registerSync,
  articleId,
  onNotify,
}: Props) {
  const [bubbleAlt, setBubbleAlt] = useState("");
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  // BubbleMenu 的目标节点信息（shouldShow 时快照）
  const selectedMediaRef = useRef<{
    type: "image" | "videoBlock";
    url: string;
    pos: number;
  } | null>(null);

  const editor = useEditor({
    extensions: buildEditorExtensions(),
    content: markdownToEditorJson(initialBody),
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "post-rich-editor" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false; // 纯文本粘贴走默认
        event.preventDefault();
        void insertUploadedFiles(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertUploadedFiles(files, pos);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      onBodyChange(serializeDocToMarkdown(e.state.doc));
    },
  });

  /** 按文档顺序找 uploadId 占位节点位置 */
  const findUploadPos = useCallback(
    (uploadId: string): number | null => {
      if (!editor) return null;
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found == null && node.attrs.uploadId === uploadId) found = pos;
      });
      return found;
    },
    [editor]
  );

  const setNodeAttrsByUploadId = useCallback(
    (uploadId: string, attrs: Record<string, unknown>) => {
      if (!editor) return;
      const pos = findUploadPos(uploadId);
      if (pos == null) return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node) return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, null, { ...node.attrs, ...attrs })
      );
    },
    [editor, findUploadPos]
  );

  const removeNodeByUploadId = useCallback(
    (uploadId: string) => {
      if (!editor) return;
      const pos = findUploadPos(uploadId);
      if (pos == null) return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node) return;
      editor.view.dispatch(
        editor.state.tr.delete(pos, pos + node.nodeSize)
      );
    },
    [editor, findUploadPos]
  );

  /** A4：上传文件 → 占位节点 → 真实 URL（失败移除占位 + 通知） */
  const insertUploadedFiles = useCallback(
    async (files: File[], pos?: number) => {
      if (!editor) return;
      for (const file of files) {
        const kind = mediaKindByExtension(fileExtensionOf(file.name || ""));
        if (!kind) {
          onNotify(
            `「${file.name || "未命名文件"}」：不支持的文件类型（图片 jpg/png/gif/webp，视频 mp4/webm）`
          );
          continue;
        }
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const nodeType = kind === "image" ? "image" : "videoBlock";
        const alt = altFromFileName(file.name || "");
        const chain = editor.chain().focus();
        const insertPayload = {
          type: nodeType,
          attrs: {
            uploadId,
            uploading: true,
            alt,
            ...(kind === "image" ? { src: "" } : { url: "" }),
          },
        };
        if (pos == null) {
          chain.insertContent(insertPayload).run();
        } else {
          chain.insertContentAt(pos, insertPayload).run();
        }
        try {
          const url = await uploadMediaFile(file);
          setNodeAttrsByUploadId(uploadId, {
            uploading: false,
            ...(kind === "image" ? { src: url } : { url }),
          });
        } catch (error) {
          removeNodeByUploadId(uploadId);
          onNotify(
            `「${file.name}」上传失败：${error instanceof Error ? error.message : "网络异常，请重试"}`
          );
        }
      }
    },
    [editor, onNotify, removeNodeByUploadId, setNodeAttrsByUploadId]
  );

  // 外部 body 回灌（面板移动/移除、源码模式切换后进入富文本）
  useEffect(() => {
    if (!editor) return;
    registerSync((md: string) => {
      editor.commands.setContent(markdownToEditorJson(md), false);
    });
  }, [editor, registerSync]);

  // ---- BubbleMenu（B1/B3）----

  const mediaMenuShouldShow = useCallback((props: { editor: Editor }) => {
    const e = props.editor;
    if (!e.isEditable) return false;
    const { selection } = e.state;
    if (!selection.empty) return false;
    const node = selection.$from.nodeAfter ?? e.state.doc.nodeAt(selection.from);
    if (!node || (node.type.name !== "image" && node.type.name !== "videoBlock")) {
      selectedMediaRef.current = null;
      return false;
    }
    selectedMediaRef.current = {
      type: node.type.name as "image" | "videoBlock",
      url: (node.attrs.src as string) || (node.attrs.url as string) || "",
      pos: selection.from,
    };
    setBubbleAlt(node.attrs.alt ?? "");
    return true;
  }, []);

  /** B3：彻底删除 = 移除节点 + 删盘（带 excludeArticleId 修"自身引用"语义） */
  const deleteMediaPermanently = useCallback(async () => {
    const target = selectedMediaRef.current;
    if (!target || !editor) return;
    const label = target.url.split("/").pop() || target.url;
    const confirmed = window.confirm(
      `彻底删除「${label}」？\n\n` +
        `· 该文件若未被其他文章引用，将从服务器永久删除（不可恢复）；\n` +
        `· 若仍被其他文章引用，将仅从本文移除，文件保留。`
    );
    if (!confirmed) return;
    try {
      const res = await fetchWithCsrf("/api/admin/media", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: target.url,
          ...(articleId ? { excludeArticleId: articleId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        referencedBy?: number;
        removed?: boolean;
      };
      if (res.status === 409) {
        // B3：被其他文章引用 → 仅从本文移除节点，文件保留，菜单明示原因
        editor.chain().focus().deleteSelection().run();
        onNotify(
          `「${label}」被其他 ${data.referencedBy ?? "?"} 处文章内容引用，已仅从本文移除（文件保留）`
        );
        return;
      }
      if (!res.ok || !data.ok) {
        onNotify(`「${label}」删除失败：${data.error || `HTTP ${res.status}`}`);
        return;
      }
      editor.chain().focus().deleteSelection().run();
      if (data.removed === false) {
        // 文件此前已不在磁盘（幂等），节点已移除即可
        return;
      }
    } catch {
      onNotify(`「${label}」删除失败：网络异常，请重试`);
    }
  }, [articleId, editor, onNotify]);

  if (!editor) {
    return (
      <div className="min-h-[18rem] animate-pulse rounded-md border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60" />
    );
  }
  const mediaActions = { articleId, onNotify };

  const updateSelectedMedia = (attrs: Record<string, unknown>) => {
    const target = selectedMediaRef.current;
    if (!target) return;
    editor
      .chain()
      .focus()
      .updateAttributes(target.type, attrs)
      .run();
  };

  return (
    <MediaActionsContext.Provider value={mediaActions}>
    <div className="flex flex-col gap-2">
      {/* 工具栏（A5：既有媒体按钮迁移 + 基础排版能力） */}
      <div className="flex flex-wrap items-center gap-1.5">
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive("bold")}
          label="B"
          title="加粗"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive("italic")}
          label="I"
          title="斜体"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor.isActive("heading", { level: 2 })}
          label="H2"
          title="二级标题"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          active={editor.isActive("blockquote")}
          label="❝"
          title="引用"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive("bulletList")}
          label="• —"
          title="无序列表"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive("orderedList")}
          label="1."
          title="有序列表"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          active={editor.isActive("codeBlock")}
          label="{ }"
          title="代码块"
        />
        <EditorToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          label="—"
          title="水平线"
        />
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />
        <button
          type="button"
          onClick={() => imageInputRef.current?.click()}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-sky-400 hover:text-sky-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-sky-500 dark:hover:text-sky-400"
        >
          🖼 图片
        </button>
        <button
          type="button"
          onClick={() => videoInputRef.current?.click()}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-sky-400 hover:text-sky-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-sky-500 dark:hover:text-sky-400"
        >
          🎬 视频
        </button>
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
          支持粘贴 / 拖入文件直接上传；拖动图片视频可调整位置
        </span>
      </div>

      <EditorContent
        editor={editor}
        className="prose-content min-h-[24rem] rounded-md border border-slate-300 bg-white px-3 py-2 shadow-sm focus-within:border-sky-500 dark:border-slate-700 dark:bg-slate-800"
      />

      {/* B1：选中媒体节点浮现的编辑菜单 */}
      <BubbleMenu editor={editor} shouldShow={mediaMenuShouldShow} tippyOptions={{ placement: "top", offset: [0, 8] }}>
        <div className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-800">
        <input
          type="text"
          value={bubbleAlt}
          onChange={(e) => {
            setBubbleAlt(e.target.value);
            updateSelectedMedia({ alt: e.target.value });
          }}
          placeholder="alt 描述"
          aria-label="媒体 alt 描述"
          maxLength={200}
          className="w-36 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
        />
        <button
          type="button"
          onClick={() => {
            const target = selectedMediaRef.current;
            if (target) {
              void navigator.clipboard?.writeText(target.url).catch(() => {});
            }
          }}
          className="rounded px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
          title="复制媒体 URL"
        >
          复制 URL
        </button>
        <button
          type="button"
          onClick={() => {
            const target = selectedMediaRef.current;
            if (!target) return;
            if (target.type === "image") imageInputRef.current?.click();
            else videoInputRef.current?.click();
          }}
          className="rounded px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
          title="重新上传替换该文件"
        >
          替换文件
        </button>
        <button
          type="button"
          onClick={() => void deleteMediaPermanently()}
          className="rounded bg-rose-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-700"
          title="从服务器永久删除（仍被其他文章引用时仅从本文移除）"
        >
          彻底删除
        </button>
        </div>
      </BubbleMenu>

      {/* 替换文件/工具栏上传的入口 */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const target = selectedMediaRef.current;
          void (async () => {
            for (const file of files) {
              try {
                const url = await uploadMediaFile(file);
                if (target && files.length === 1) {
                  // BubbleMenu 替换：更新选中节点
                  updateSelectedMedia({ src: url, alt: altFromFileName(file.name), uploading: false });
                } else {
                  await insertUploadedFiles([file]);
                }
              } catch (error) {
                onNotify(
                  `「${file.name}」上传失败：${error instanceof Error ? error.message : "网络异常，请重试"}`
                );
              }
            }
          })();
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm,.mp4,.webm"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const target = selectedMediaRef.current;
          void (async () => {
            for (const file of files) {
              try {
                const url = await uploadMediaFile(file);
                if (target && files.length === 1) {
                  updateSelectedMedia({ url, alt: altFromFileName(file.name), uploading: false });
                } else {
                  await insertUploadedFiles([file]);
                }
              } catch (error) {
                onNotify(
                  `「${file.name}」上传失败：${error instanceof Error ? error.message : "网络异常，请重试"}`
                );
              }
            }
          })();
        }}
      />
    </div>
    </MediaActionsContext.Provider>
  );
}

function EditorToolbarButton({
  onClick,
  active,
  label,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={
        "min-w-[2rem] rounded-md border px-2 py-1 text-xs font-medium transition-colors " +
        (active
          ? "border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-600 dark:bg-sky-950/40 dark:text-sky-300"
          : "border-slate-300 bg-white text-slate-600 hover:border-sky-400 hover:text-sky-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-sky-500 dark:hover:text-sky-400")
      }
    >
      {label}
    </button>
  );
}

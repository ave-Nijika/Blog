"use client";

/**
 * 文章编辑器（新建/编辑共用）。
 *
 * 字段：
 *   - title, slug, summary, category, tags (逗号分隔),
 *     status (draft|public|private), pinned, publishedAt, body (markdown)
 *
 * 行为：
 *   - 保存草稿 → status=draft，写入
 *   - 发布 → status=public，写入
 *   - 改为私有 → status=private，写入
 *   - 预览切换：在编辑器右侧/下方展开 react-markdown 渲染（与文章详情页共用
 *     lib/markdown-components.tsx 渲染配置，M1-补丁1 C1）
 *   - 媒体（M1-补丁1 B/D）：工具栏图片/视频按钮、textarea 粘贴/拖拽上传
 *     （POST /api/admin/upload），在光标/落点处插入媒体块（前后各空一行）；
 *     侧边媒体面板按文档顺序列出媒体块，HTML5 拖拽整块移动、✕ 从正文移除
 *     （只动正文不动服务器文件，文件清理由删文时的引用计数统一负责）
 *   - 校验：title 非空、slug 合法、status 合法由服务端最终把关
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { fetchWithCsrf } from "@/lib/fetchWithCsrf";
import { RichTextEditor } from "@/lib/editor/RichTextEditor";
import { TwoStepButton } from "@/components/TwoStepButton";
import { getMarkdownComponents } from "@/lib/markdown-components";
import {
  altFromFileName,
  buildMediaSnippet,
  fileExtensionOf,
  findMediaBlocks,
  insertMediaAt,
  mediaKindByExtension,
  moveMediaBlockAt,
  removeMediaBlockAt,
  renderVideoSyntax,
  thumbnailUrlFor,
  type MediaBlockInfo,
  type MediaKind,
} from "@/lib/media";

export type PostFormValues = {
  id?: string;
  title: string;
  slug: string;
  summary: string;
  status: "draft" | "public" | "private";
  category: string;
  tagsInput: string;
  pinned: boolean;
  publishedAt: string; // ISO 字符串或空字符串
  body: string;
};

type TaxonomyItem = { id: string; name: string; slug: string };

type Taxonomy = { categories: TaxonomyItem[]; tags: TaxonomyItem[] };

type Props = {
  initial: PostFormValues;
  mode: "create" | "edit";
};

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** C2：编辑器形态记入 localStorage，下次进入保持；默认富文本 */
const EDITOR_MODE_STORAGE_KEY = "plana-post-editor-mode";

function readStoredEditorMode(): "richtext" | "source" {
  try {
    const v = localStorage.getItem(EDITOR_MODE_STORAGE_KEY);
    return v === "source" ? "source" : "richtext";
  } catch {
    return "richtext";
  }
}

function toInputDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // 转为 <input type="datetime-local"> 接受的本地时间
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromInputDateTime(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * B3：估算文件拖落的正文落点——caretRangeFromPoint/caretPositionFromPoint
 * 对 <textarea> 会返回文本偏移；拿不到则回退当前光标位置。
 */
function caretIndexFromDropEvent(
  view: { document?: Document } | null | undefined,
  textarea: HTMLTextAreaElement | null,
  x: number,
  y: number
): number | null {
  const doc = (view?.document ?? document) as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
  };
  try {
    if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(x, y);
      if (range && range.startContainer === textarea) return range.startOffset;
    } else if (typeof doc.caretPositionFromPoint === "function") {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode === textarea) return pos.offset;
    }
  } catch {
    /* 回退光标位置 */
  }
  return null;
}

export function PostEditor({ initial, mode }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<PostFormValues>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, startDelete] = useTransition();

  // ---- 媒体上传状态（M1-补丁1 B）----
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // 正文 ref 镜像：上传是异步的，插入时以最新正文为基（用户上传期间输入不丢失）
  const bodyTextRef = useRef<string>(initial.body);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingKind, setUploadingKind] = useState<MediaKind | "multi" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // 插入完成后把光标恢复到媒体块之后（body 变化的 effect 里消费）
  const restoreCursorRef = useRef<number | null>(null);
  const uploadErrorTimerRef = useRef<number | null>(null);

  // ---- 双形态编辑器（M2-补丁1 C）：富文本(Tiptap) ⇄ 源码(textarea) ----
  // 回滚开关即本切换本身：Tiptap 有任何问题，切回源码即回到 M1-补丁1 行为。
  const [editorMode, setEditorMode] = useState<"richtext" | "source">(
    () => readStoredEditorMode()
  );
  const richSyncRef = useRef<((md: string) => void) | null>(null);
  const registerRichSync = useCallback((fn: (md: string) => void) => {
    richSyncRef.current = fn;
  }, []);

  /** 统一的正文外部变更入口（媒体面板/彻底删除）：更新 ref + state 并回灌富文本编辑器 */
  function applyBodyChange(next: string) {
    bodyTextRef.current = next;
    setValues((prev) => ({ ...prev, body: next }));
    richSyncRef.current?.(next);
  }

  function switchEditorMode(next: "richtext" | "source") {
    if (next === editorMode) return;
    setEditorMode(next);
    try {
      localStorage.setItem(EDITOR_MODE_STORAGE_KEY, next);
    } catch {
      /* 隐私模式等：形态记忆不可用不影响功能 */
    }
  }

  const showUploadError = (message: string) => {
    setUploadError(message);
    if (uploadErrorTimerRef.current) window.clearTimeout(uploadErrorTimerRef.current);
    uploadErrorTimerRef.current = window.setTimeout(() => setUploadError(null), 6000);
  };

  useEffect(() => {
    return () => {
      if (uploadErrorTimerRef.current) window.clearTimeout(uploadErrorTimerRef.current);
    };
  }, []);

  // body 变化后恢复光标到刚插入的媒体块之后
  useEffect(() => {
    if (restoreCursorRef.current == null) return;
    const pos = restoreCursorRef.current;
    restoreCursorRef.current = null;
    const el = bodyRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, [values.body]);

  // D1：媒体面板数据（按文档顺序；无媒体时面板隐藏）
  const mediaBlocks = useMemo(() => findMediaBlocks(values.body), [values.body]);

  // 预置分类/标签（含自定义与文章聚合项，见 /api/admin/taxonomy）。
  // 拉取失败不影响编辑器：快捷选择只是增强，输入框始终可用。
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({ categories: [], tags: [] });
  useEffect(() => {
    let cancelled = false;
    fetchWithCsrf("/api/admin/taxonomy")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as
          | (Taxonomy & { ok?: boolean })
          | null;
        if (!cancelled && data) {
          setTaxonomy({
            categories: data.categories ?? [],
            tags: data.tags ?? [],
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 分类快捷项：始终全量展示。此前的"按输入过滤"在两个场景下都会把其余
  // 预置项藏掉：① 编辑页初始预填了文章旧分类；② 点击任一 chip 本身就会
  // 改 values.category。预置总数少，搜索过滤没有价值，故彻底移除。
  const categoryInput = values.category.trim();
  const categoryPresets = taxonomy.categories;
  // 标签快捷项：已加入的置灰不可重复点击
  const currentTags = values.tagsInput
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  function addTag(name: string) {
    if (currentTags.includes(name)) return;
    update("tagsInput", [...currentTags, name].join(", "));
  }

  function update<K extends keyof PostFormValues>(key: K, value: PostFormValues[K]) {
    if (key === "body") bodyTextRef.current = value as string;
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * B1/B2/B3：顺序上传文件并在指定正文位置依次插入媒体块。
   * 多文件时逐个插入，后一个文件接在前一个媒体块之后。
   * 基于正文的 ref 镜像（bodyTextRef）做插入：上传耗时期间用户继续输入的
   * 内容不会被闭包里的旧正文覆盖。
   */
  async function uploadFilesAndInsert(files: File[], position: number) {
    if (files.length === 0) return;
    if (uploadingKind !== null) {
      showUploadError("已有上传在进行中，请等它完成后再试");
      return;
    }
    setError(null);
    setUploadingKind(files.length > 1 ? "multi" : (mediaKindByExtension(fileExtensionOf(files[0]?.name ?? "")) ?? "image"));

    let pos = Math.max(0, Math.min(position, bodyTextRef.current.length));

    for (const file of files) {
      const ext = fileExtensionOf(file.name || "");
      const kind = mediaKindByExtension(ext);
      if (!kind) {
        showUploadError(`「${file.name || "未命名文件"}」：不支持的文件类型（图片 jpg/png/gif/webp，视频 mp4/webm）`);
        continue;
      }
      try {
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
          showUploadError(`「${file.name}」上传失败：${data.error || `HTTP ${res.status}`}`);
          continue;
        }
        // B5：alt 默认取文件名去扩展名
        const snippet = buildMediaSnippet(kind, altFromFileName(file.name || ""), data.url);
        const next = insertMediaAt(bodyTextRef.current, Math.min(pos, bodyTextRef.current.length), snippet);
        pos = next.indexOf(snippet) + snippet.length;
        bodyTextRef.current = next;
        restoreCursorRef.current = pos;
        update("body", next);
      } catch {
        showUploadError(`「${file.name}」上传失败：网络异常，请重试`);
      }
    }

    setUploadingKind(null);
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // B2：含文件时接管粘贴并上传；纯文本粘贴行为完全不变
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const pos = e.currentTarget.selectionStart ?? values.body.length;
    void uploadFilesAndInsert(files, pos);
  }

  function onDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
      e.preventDefault(); // 允许文件拖放（B3）；文本拖拽不拦截
    }
  }

  function onDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const estimated = caretIndexFromDropEvent(
      e.view,
      e.currentTarget,
      e.clientX,
      e.clientY
    );
    const pos = estimated ?? e.currentTarget.selectionStart ?? values.body.length;
    void uploadFilesAndInsert(files, pos);
  }

  /**
   * B（M1-补丁2）+ M2-补丁3 C2：媒体面板"彻底删除"——确认已由按钮层
   * 两段式内置完成（不再 window.confirm：原生对话框阻塞主线程即主人反馈
   * 的"页面卡住"），本函数只负责执行：调 DELETE /api/admin/media；
   * 409 展示引用数且不重试；成功后把该文件在本文中的全部媒体块从正文
   * 移除（文件已删，保留块只会得到坏图），面板列表随 body 派生自动更新。
   */
  async function deleteMediaFile(url: string) {
    const label = url.split("/").pop() || url;
    try {
      const res = await fetchWithCsrf("/api/admin/media", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        // B2：排除正在编辑的文章自身（磁盘旧版 md 的引用不算数——
        // 修"图在本文档里就永远删不掉"的语义错误；新建文章无 id 不传）
        body: JSON.stringify({
          url,
          ...(mode === "edit" && values.id ? { excludeArticleId: values.id } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        referencedBy?: number;
      };
      if (res.status === 409) {
        // B4：展示服务端返回的引用数，不重试不循环
        showUploadError(`「${label}」${data.error || `仍被 ${data.referencedBy ?? "?"} 处引用，无法删除`}`);
        return;
      }
      if (!res.ok || !data.ok) {
        showUploadError(`「${label}」删除失败：${data.error || `HTTP ${res.status}`}`);
        return;
      }
      // B3：从正文移除全部引用该文件的媒体块（从后往前删，行号不失效）
      let body = bodyTextRef.current;
      for (;;) {
        const blocks = findMediaBlocks(body);
        const last = blocks.findIndex((b) => b.url === url);
        if (last === -1) break;
        body = removeMediaBlockAt(body, last);
      }
      applyBodyChange(body);
    } catch {
      showUploadError(`「${label}」删除失败：网络异常，请重试`);
    }
  }

  function buildPayload(targetStatus: "draft" | "public" | "private") {
    // 发布时间语义：
    // - 发布时（targetStatus === "public"）：publishedAt 为空则自动设为当前时间
    // - 用户手动输入了时间则用用户输入的值（已发布文章的"更新发布"也尊重用户选择）
    // - 非发布状态（草稿/私有）：存用户输入值或 null
    const publishedAt =
      targetStatus === "public"
        ? fromInputDateTime(values.publishedAt) || new Date().toISOString()
        : fromInputDateTime(values.publishedAt);
    return {
      slug: values.slug.trim(),
      title: values.title.trim(),
      summary: values.summary.trim(),
      status: targetStatus,
      category: values.category.trim(),
      cover: "",
      pinned: values.pinned,
      publishedAt,
      tags: values.tagsInput
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      body: values.body,
    };
  }

  function save(targetStatus: "draft" | "public" | "private") {
    setError(null);
    setSuccess(null);
    if (!values.title.trim()) {
      setError("标题不能为空");
      return;
    }
    if (!SLUG_RE.test(values.slug.trim())) {
      setError("slug 只能包含小写字母、数字和中划线");
      return;
    }
    const payload = buildPayload(targetStatus);
    startTransition(async () => {
      try {
        const url =
          mode === "create"
            ? "/api/admin/posts"
            : `/api/admin/posts/${values.id}`;
        const method = mode === "create" ? "POST" : "PUT";
        const res = await fetchWithCsrf(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          post?: { id: string; slug: string; status: string };
          error?: string;
        };
        if (!res.ok || !data.ok) {
          setError(data.error || "保存失败");
          return;
        }
        setSuccess("已保存并产生 Git 提交。");
        if (mode === "create" && data.post?.id) {
          router.replace(`/admin/posts/${data.post.id}/edit`);
        } else {
          router.refresh();
        }
        if (data.post) {
          setValues((prev) => ({
            ...prev,
            status: data.post!.status as PostFormValues["status"],
            slug: data.post!.slug,
          }));
        }
      } catch {
        setError("网络异常，请重试");
      }
    });
  }

  function doDelete() {
    if (!values.id) return;
    setError(null);
    setSuccess(null);
    startDelete(async () => {
      try {
        const res = await fetchWithCsrf(`/api/admin/posts/${values.id}`, {
          method: "DELETE",
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          setError(data.error || "删除失败");
          return;
        }
        router.replace("/admin/posts");
        router.refresh();
      } catch {
        setError("网络异常，请重试");
      }
    });
  }

  const isPublic = values.status === "public";
  const isDraft = values.status === "draft";
  const uploadDisabled = uploadingKind !== null;
  const markdownComponents = useMemo(() => getMarkdownComponents(), []);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {success}
        </div>
      ) : null}

      {/* 状态下拉已删除（与三个动作按钮冗余），标题+slug 改两列均分，
          消除原三列栅格第三列的空白（主人截图红圈处） */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="标题" required>
          <input
            type="text"
            value={values.title}
            onChange={(e) => update("title", e.target.value)}
            maxLength={200}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </Field>
        <Field
          label="slug"
          hint="仅小写字母、数字与中划线，作为文件名（content/posts/<slug>.md）"
        >
          <input
            type="text"
            value={values.slug}
            onChange={(e) => update("slug", e.target.value)}
            pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </Field>
      </div>

      <Field label="摘要">
        <textarea
          value={values.summary}
          onChange={(e) => update("summary", e.target.value)}
          rows={2}
          maxLength={500}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
      </Field>

      <div className="grid gap-4 lg:grid-cols-3">
        <Field label="分类" hint="点击预置项快速填入，也可自由输入">
          <input
            type="text"
            value={values.category}
            onChange={(e) => update("category", e.target.value)}
            maxLength={64}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          {categoryPresets.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {categoryPresets.map((c) => (
                <PresetChip
                  key={c.id || c.name}
                  label={c.name}
                  active={categoryInput === c.name}
                  onClick={() => update("category", c.name)}
                />
              ))}
            </div>
          ) : null}
        </Field>
        <Field label="标签" hint="使用逗号分隔；点击预置标签加入，已加入的置灰">
          <input
            type="text"
            value={values.tagsInput}
            onChange={(e) => update("tagsInput", e.target.value)}
            placeholder="例：随笔, 学习, 算法"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          {taxonomy.tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {taxonomy.tags.map((tag) => (
                <PresetChip
                  key={tag.id || tag.name}
                  label={tag.name}
                  active={currentTags.includes(tag.name)}
                  dimmed={currentTags.includes(tag.name)}
                  onClick={() => addTag(tag.name)}
                />
              ))}
            </div>
          ) : null}
        </Field>
        <Field label="发布时间" hint="发布时若留空将自动设为现在">
          <input
            type="datetime-local"
            value={toInputDateTime(values.publishedAt)}
            onChange={(e) => update("publishedAt", e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </Field>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={values.pinned}
            onChange={(e) => update("pinned", e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:text-sky-400 dark:focus:ring-sky-400"
          />
          置顶
        </label>
        <span className="ml-3 text-xs text-slate-500 dark:text-slate-400">
          状态：{isDraft ? "草稿" : isPublic ? "已发布" : "私有"}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => save("draft")}
            disabled={pending}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          >
            {pending ? "保存中…" : isDraft ? "保存草稿" : "保存为草稿"}
          </button>
          <button
            type="button"
            onClick={() => save("public")}
            disabled={pending}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            {pending ? "发布中…" : isPublic ? "更新发布" : "发布"}
          </button>
          <button
            type="button"
            onClick={() => save("private")}
            disabled={pending}
            className="rounded-md border border-slate-500 bg-slate-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-60"
          >
            {pending ? "处理中…" : "改为私有"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="ba-btn px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {showPreview ? "隐藏预览" : "实时预览"}
          </button>
          {mode === "edit" ? (
            confirmDelete ? (
              <button
                type="button"
                onClick={doDelete}
                disabled={deleting}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-700 disabled:opacity-60"
              >
                {deleting ? "删除中…" : "再次点击确认删除"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-60 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/40"
              >
                删除
              </button>
            )
          ) : null}
        </div>
      </div>

      <div className={showPreview ? "grid gap-4 lg:grid-cols-2" : ""}>
        {/* 正文列：不用 <label> 包裹（内部有按钮/面板，避免误聚焦 textarea） */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
              正文{editorMode === "richtext" ? "（所见即所得）" : "（Markdown 源码）"}
              <span className="ml-2 font-normal text-xs text-slate-400 dark:text-slate-500">
                {editorMode === "richtext"
                  ? "支持粘贴 / 拖入图片视频直接上传；拖动媒体可调整位置"
                  : "支持粘贴 / 拖入图片视频直接上传"}
              </span>
            </span>
            <div className="flex items-center gap-1.5">
              {/* 源码模式保留 M1-补丁1 的图片/视频按钮（富文本模式在编辑器工具栏内） */}
              {editorMode === "source" ? (
                <>
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={uploadDisabled}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-sky-400 hover:text-sky-600 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-sky-500 dark:hover:text-sky-400"
                  >
                    {uploadingKind === "image" ? "上传中…" : "🖼 图片"}
                  </button>
                  <button
                    type="button"
                    onClick={() => videoInputRef.current?.click()}
                    disabled={uploadDisabled}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-sky-400 hover:text-sky-600 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-sky-500 dark:hover:text-sky-400"
                  >
                    {uploadingKind === "video" ? "上传中…" : "🎬 视频"}
                  </button>
                </>
              ) : null}
              {/* C1/C4：形态切换即回滚开关 */}
              <div
                role="tablist"
                aria-label="编辑器形态"
                className="flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={editorMode === "richtext"}
                  onClick={() => switchEditorMode("richtext")}
                  className={
                    "px-2.5 py-1 text-xs font-medium transition-colors " +
                    (editorMode === "richtext"
                      ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                      : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")
                  }
                >
                  富文本
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editorMode === "source"}
                  onClick={() => switchEditorMode("source")}
                  className={
                    "px-2.5 py-1 text-xs font-medium transition-colors " +
                    (editorMode === "source"
                      ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                      : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")
                  }
                >
                  源码
                </button>
              </div>
            </div>
          </div>

          {editorMode === "richtext" ? (
            <RichTextEditor
              initialBody={values.body}
              onBodyChange={(md) => {
                bodyTextRef.current = md;
                update("body", md);
              }}
              registerSync={registerRichSync}
              articleId={mode === "edit" ? values.id : undefined}
              onNotify={showUploadError}
            />
          ) : (
            <>
              <textarea
                id="post-body-textarea"
                ref={bodyRef}
                value={values.body}
                onChange={(e) => update("body", e.target.value)}
                onPaste={onPaste}
                onDragOver={onDragOver}
                onDrop={onDrop}
                rows={showPreview ? 18 : 24}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />

              {/* B4：上传失败反馈（不静默失败） */}
              {uploadError ? (
                <div
                  role="alert"
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  {uploadError}
                </div>
              ) : null}

              {/* B5/D：隐藏的文件选择入口 */}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  const pos = bodyRef.current?.selectionStart ?? values.body.length;
                  e.target.value = ""; // 允许重复选择同一文件
                  void uploadFilesAndInsert(files, pos);
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
                  const pos = bodyRef.current?.selectionStart ?? values.body.length;
                  e.target.value = "";
                  void uploadFilesAndInsert(files, pos);
                }}
              />
            </>
          )}
        </div>
        {showPreview ? (
          <Field label="预览" full>
            <div className="prose-content min-h-[24rem] rounded-md border border-slate-200 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-900/40">
              {values.body.trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={markdownComponents}
                >
                  {renderVideoSyntax(values.body)}
                </ReactMarkdown>
              ) : (
                <p className="text-sm text-slate-400 dark:text-slate-500">暂无内容可预览</p>
              )}
            </div>
          </Field>
        ) : null}
      </div>

      {/* D：媒体面板（按文档顺序；无媒体时隐藏） */}
      {mediaBlocks.length > 0 ? (
        <MediaPanel
          items={mediaBlocks}
          onMove={(from, to) => applyBodyChange(moveMediaBlockAt(values.body, from, to))}
          onRemove={(index) => applyBodyChange(removeMediaBlockAt(values.body, index))}
          onDeleteFile={(url) => void deleteMediaFile(url)}
        />
      ) : null}
    </div>
  );
}

/**
 * D：媒体面板——列出正文中的媒体块（缩略图/图标 + alt），HTML5 draggable
 * 拖拽整块移动（指示线 = 被拖块将成为的位置），✕ 把该块从正文移除。
 * 「彻底删除」（M1-补丁2 B）：独立危险色操作，删服务器文件（引用计数
 * 由后端把关，被引用文件拒绝删除）。正文变换全部委托 lib/media.ts
 * 纯函数（其余内容零改动由单测保证）。
 */
function MediaPanel({
  items,
  onMove,
  onRemove,
  onDeleteFile,
}: {
  items: MediaBlockInfo[];
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onDeleteFile: (url: string) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const clearDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="ba-card p-4">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="ba-tri h-3 w-4" aria-hidden />
        <span className="ba-font-round text-[color:rgb(var(--color-text-primary))] dark:text-slate-100">
          媒体（{items.length}）
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          拖动调整位置；✕ 仅从正文移除（文件保留，可去「媒体管理」清理）；「彻底删除」删服务器文件
        </span>
      </div>
      <ul className="flex flex-col">
        {items.map((item, i) => {
          const dragging = dragIndex === i;
          // 指示线：悬停条目上方 = 被拖块将移动到该位置（与 moveMediaBlockAt 语义一致）
          const indicator =
            dragIndex !== null && overIndex === i && dragIndex !== i;
          return (
            <li
              key={`${item.url}-${item.startLine}`}
              draggable
              onDragStart={(e) => {
                setDragIndex(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragEnd={clearDrag}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== i) onMove(dragIndex, i);
                clearDrag();
              }}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${
                dragging
                  ? "border-sky-400 bg-sky-50 opacity-60 dark:border-sky-600 dark:bg-sky-950/40"
                  : "border-transparent"
              } ${indicator ? "border-t-2 border-t-sky-500" : ""} cursor-grab active:cursor-grabbing`}
            >
              <span
                className="select-none text-xs text-slate-400 dark:text-slate-500"
                aria-hidden
              >
                ⠿
              </span>
              {item.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbnailUrlFor(item.url) ?? item.url}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    // B5/A4：缩略图缺失降级原图（一次性切 src）
                    const original = thumbnailUrlFor(item.url);
                    if (original && e.currentTarget.src.endsWith(thumbnailUrlFor(item.url)!)) {
                      e.currentTarget.src = item.url;
                    }
                  }}
                  className="h-10 w-16 shrink-0 rounded border border-slate-200 object-cover dark:border-slate-700"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-10 w-16 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50 text-lg dark:border-slate-700 dark:bg-slate-800"
                >
                  🎬
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-slate-700 dark:text-slate-200">
                  {item.alt || item.url.split("/").pop()}
                </span>
                <span className="block truncate text-xs text-slate-400 dark:text-slate-500">
                  {item.kind === "image" ? "图片" : "视频"} · {item.url}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {/* ✕ 仅从正文移除（文件保留，孤儿清理由删除联动/媒体管理负责） */}
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`从正文移除媒体 ${item.alt || item.url}`}
                  title="仅从正文移除（服务器文件保留）"
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 transition-colors hover:border-rose-300 hover:text-rose-600 dark:border-slate-700 dark:text-slate-400 dark:hover:border-rose-800 dark:hover:text-rose-400"
                >
                  ✕
                </button>
                {/* 彻底删除（M1-补丁2 B1）：危险色实底 + 文字标签，与 ✕ 视觉区分；
                    M2-补丁3 C2：两段式内置确认——第一击变"确认删除？"（非阻塞），
                    3 秒内再击执行，超时回退（不再 window.confirm） */}
                <TwoStepButton
                  label="彻底删除"
                  confirmLabel="确认删除？"
                  onConfirm={() => onDeleteFile(item.url)}
                  title="从服务器永久删除该文件（仍被其他文章引用时会被拒绝）"
                  confirmTitle="再次点击确认从服务器永久删除"
                  ariaLabel={`彻底删除文件 ${item.alt || item.url}`}
                  confirmAriaLabel={`确认删除文件 ${item.alt || item.url}`}
                  className="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-rose-700"
                  confirmClassName="rounded-md bg-rose-700 px-2 py-1 text-xs font-medium text-white shadow-sm ring-2 ring-rose-400"
                />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  full,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={"flex flex-col gap-1 " + (full ? "w-full" : "")}>
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
        {required ? <span className="ml-1 text-rose-600 dark:text-rose-400">*</span> : null}
      </span>
      {children}
      {hint ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      ) : null}
    </label>
  );
}

/** 预置分类/标签 chip：active 表示已选中/已加入，dimmed 表示不可再点（已加入） */
function PresetChip({
  label,
  active,
  dimmed = false,
  onClick,
}: {
  label: string;
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-disabled={dimmed || undefined}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active
          ? "border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-600 dark:bg-sky-950/40 dark:text-sky-300"
          : "border-slate-200 bg-slate-50 text-slate-600 hover:border-sky-400 hover:text-sky-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-sky-500 dark:hover:text-sky-400"
      } ${
        dimmed
          ? "cursor-default opacity-45 hover:border-slate-200 hover:text-slate-600 dark:hover:border-slate-700 dark:hover:text-slate-300"
          : ""
      }`}
    >
      {label}
    </button>
  );
}

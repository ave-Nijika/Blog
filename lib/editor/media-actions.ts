"use client";

/**
 * NodeView 与编辑器宿主（RichTextEditor）之间的操作上下文（M2-补丁2 B3）。
 * 独立文件避免 node-views ↔ RichTextEditor 循环 import。
 */
import { createContext, useContext } from "react";

export interface MediaActions {
  /** 当前文章 id（新建文章 undefined）——删除文件的 excludeArticleId */
  articleId: string | undefined;
  /** 用户可见提示（409/失败不静默） */
  onNotify: (message: string) => void;
}

export const MediaActionsContext = createContext<MediaActions>({
  articleId: undefined,
  onNotify: () => {},
});

export function useMediaActions(): MediaActions {
  return useContext(MediaActionsContext);
}

/** DELETE /api/admin/media 的 NodeView 共享封装（B3：带 excludeArticleId） */
export async function deleteMediaFileByApi(
  url: string,
  articleId: string | undefined
): Promise<{ ok: boolean; removed?: boolean; referencedBy?: number; error?: string }> {
  const { fetchWithCsrf } = await import("@/lib/fetchWithCsrf");
  const res = await fetchWithCsrf("/api/admin/media", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      ...(articleId ? { excludeArticleId: articleId } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    removed?: boolean;
    referencedBy?: number;
    error?: string;
  };
  return {
    ok: res.ok && data.ok === true,
    removed: data.removed,
    referencedBy: data.referencedBy,
    error: data.error,
  };
}

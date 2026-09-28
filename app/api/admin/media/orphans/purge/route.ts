/**
 * POST /api/admin/media/orphans/purge —— 批量清理孤儿媒体（M1-补丁2 A5）。
 *
 * body { urls: string[] }；对每个 url 独立重跑引用检查（引用索引在本请求
 * 内全新构建——防止 orphans 清单生成后文章又引用了该文件），零引用才删；
 * 返回 { deleted: [...], skipped: [{url, referencedBy}] }。
 * 每个实际删除的文件写一条 media.delete 审计（metadata.source =
 * "orphan-sweep"，targetId = url）。
 *
 * comfy 隔离：请求中任何非 /uploads/{images|videos}/ 的 url（含 comfy 路径、
 * 路径穿越）→ 整个请求 400 拒绝，绝不静默过滤——fail-closed。
 */
import { NextRequest } from "next/server";
import { requireAdminApi, getSession } from "@/lib/auth";
import { verifyCsrfToken } from "@/lib/csrf";
import { buildUploadReferenceIndex } from "@/lib/media-references";
import { deleteUploadFilesByUrls, parseUploadsUrl } from "@/lib/media-storage";
import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_URLS_PER_PURGE = 500;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminApi();
  if (guard) return guard;

  const csrfOk = await verifyCsrfToken(req);
  if (!csrfOk) return jsonResponse({ error: "CSRF 验证失败" }, 403);

  const session = await getSession();
  if (!session) return jsonResponse({ error: "未登录或会话已过期" }, 401);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "请求体格式错误" }, 400);
  }
  const rawUrls = (payload as { urls?: unknown } | null)?.urls;
  if (
    !Array.isArray(rawUrls) ||
    rawUrls.length === 0 ||
    rawUrls.some((u) => typeof u !== "string" || !u)
  ) {
    return jsonResponse({ error: "urls 必须是非空字符串数组" }, 400);
  }
  const urls = rawUrls as string[];
  if (urls.length > MAX_URLS_PER_PURGE) {
    return jsonResponse({ error: `单次最多清理 ${MAX_URLS_PER_PURGE} 个文件` }, 400);
  }
  const invalid = urls.filter((u) => !parseUploadsUrl(u));
  if (invalid.length > 0) {
    // comfy 隔离 fail-closed：images/videos 之外的路径（含 /uploads/comfy/**）
    // 一律拒绝整个请求
    return jsonResponse(
      { error: "仅支持清理站内图片/视频（/uploads/images|videos/）" },
      400
    );
  }

  const index = await buildUploadReferenceIndex();
  if (!index) {
    return jsonResponse({ error: "引用统计暂时不可用，已拒绝删除" }, 500);
  }

  const deleted: string[] = [];
  const skipped: { url: string; referencedBy: number }[] = [];
  try {
    for (const url of urls) {
      const refCount = index.get(url) ?? 0;
      if (refCount > 0) {
        skipped.push({ url, referencedBy: refCount });
        continue;
      }
      const removed = await deleteUploadFilesByUrls([url]);
      if (removed.length === 0) continue; // 文件已不存在（幂等，无需审计）
      deleted.push(url);
      await logAudit({
        adminId: session.id,
        action: AUDIT_ACTIONS.MEDIA_DELETE,
        targetType: "media",
        targetId: url,
        metadata: { url, source: "orphan-sweep" },
      });
    }
  } catch (error) {
    console.error("[admin/media/purge] failed:", error);
    return jsonResponse({ error: "文件删除失败，请稍后重试" }, 500);
  }

  return jsonResponse({ ok: true, deleted, skipped }, 200);
}

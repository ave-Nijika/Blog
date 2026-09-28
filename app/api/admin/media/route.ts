/**
 * DELETE /api/admin/media —— 媒体面板"彻底删除"（M1-补丁2 A1-A3）。
 *
 * body { url: string }（/uploads/{images|videos}/{文件名}）。
 * 删除前实时引用计数（buildUploadReferenceIndex，唯一口径 = 磁盘文章 md
 * 全文 extractAllUploadReferences）：引用数 > 0 → 409 {referencedBy}，不删；
 * 零引用 → deleteUploadFilesByUrls 删盘（文件不存在视为成功，幂等）；
 * 审计 media.delete，metadata.source = "panel"。
 *
 * 防竞态说明：删除前现查引用、现删，两步之间理论窗口内若另一会话恰好
 * 保存了引用该图的文章，以"单人博客、窗口毫秒级"接受此风险（任务书 2）。
 */
import { NextRequest } from "next/server";
import { requireAdminApi, getSession } from "@/lib/auth";
import { verifyCsrfToken } from "@/lib/csrf";
import { buildUploadReferenceIndex } from "@/lib/media-references";
import { deleteUploadFilesByUrls, parseUploadsUrl } from "@/lib/media-storage";
import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE(req: NextRequest) {
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
  const url = (payload as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !url) {
    return jsonResponse({ error: "缺少 url" }, 400);
  }
  // comfy 隔离：parseUploadsUrl 只认 /uploads/{images|videos}/，其余一律 400
  const parsed = parseUploadsUrl(url);
  if (!parsed) {
    return jsonResponse({ error: "仅支持删除站内图片/视频（/uploads/images|videos/）" }, 400);
  }

  const index = await buildUploadReferenceIndex();
  if (!index) {
    // 引用状态未知时绝不删（宁可保留不误删）
    return jsonResponse({ error: "引用统计暂时不可用，已拒绝删除" }, 500);
  }
  const refCount = index.get(url) ?? 0;
  if (refCount > 0) {
    return jsonResponse(
      {
        ok: false,
        error: `该文件仍被 ${refCount} 处文章内容引用，无法删除`,
        referencedBy: refCount,
      },
      409
    );
  }

  try {
    // deleteUploadFilesByUrls 对 ENOENT 幂等（文件已不存在 → removed 为空）
    const removed = await deleteUploadFilesByUrls([url]);
    await logAudit({
      adminId: session.id,
      action: AUDIT_ACTIONS.MEDIA_DELETE,
      targetType: "media",
      targetId: url,
      metadata: { url, source: "panel", removed: removed.length > 0 },
    });
    return jsonResponse({ ok: true, url, removed: removed.length > 0 }, 200);
  } catch (error) {
    console.error("[admin/media] delete failed:", error);
    return jsonResponse({ error: "文件删除失败，请稍后重试" }, 500);
  }
}

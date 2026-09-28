/**
 * GET /api/admin/media/orphans —— 孤儿媒体清单（M1-补丁2 A4）。
 *
 * 列出 uploads/{images|videos} 全部文件（固定两级，comfy/ 永不进入），
 * 逐个比对引用计数（唯一口径：磁盘文章 md 全文），返回零引用清单
 * [{ url, kind, sizeBytes, mtime }]，并附总文件数/总占用（C1）。
 * GET 仅需管理员会话（仓库惯例：GET 走权限但不查 CSRF）。
 */
import { requireAdminApi } from "@/lib/auth";
import { listManagedUploadFiles } from "@/lib/media-storage";
import { buildUploadReferenceIndex } from "@/lib/media-references";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  const guard = await requireAdminApi();
  if (guard) return guard;

  const files = await listManagedUploadFiles();
  const index = await buildUploadReferenceIndex();
  if (!index) {
    return jsonResponse({ error: "引用统计暂时不可用" }, 500);
  }

  const orphans = files
    .filter((f) => !index.has(f.url))
    .map((f) => ({
      url: f.url,
      kind: f.kind,
      sizeBytes: f.sizeBytes,
      mtime: f.mtime.toISOString(),
    }));

  return jsonResponse({
    ok: true,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    orphans,
  });
}

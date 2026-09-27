/**
 * POST /api/admin/upload —— 文章媒体上传（M1-补丁1 A）。
 *
 * 管理员专用（requireAdminApi 401 + CSRF 双重提交 403 + IP 限流 429）。
 * 类型白名单（MIME + 扩展名双重校验，不一致 415）：
 *   图片 jpg/jpeg/png/gif/webp ≤10MB；视频 mp4/webm ≤50MB（超限 413）。
 * 落盘 public/uploads/{images|videos}/{YYYYMMDD}-{8位随机}.{ext}
 * （文件名完全由服务端生成，不带任何客户端可控成分）；
 * 另做魔数校验（扩展名伪造的文件内容过不了这关）。
 * 返回 {ok,url,kind,size,mime}；任何失败只返回明确错误文案，
 * 不泄露服务端绝对路径与异常堆栈。上传成功写审计日志（media.upload）。
 */
import { NextRequest } from "next/server";
import { requireAdminApi, getSession } from "@/lib/auth";
import { verifyCsrfToken } from "@/lib/csrf";
import { tryConsumeUpload } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import {
  fileExtensionOf,
  imageMimeByExt,
  mediaKindByExtension,
  videoMimeByExt,
} from "@/lib/media";
import { saveMediaFile } from "@/lib/media-storage";
import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50MB

function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 魔数校验（内容与声明类型一致才放行）。JPEG/PNG/GIF/WEBP/MP4(ftyp)/WEBM(EBML)
 * 签名均为公开规范头，纯内置实现。
 */
function magicMatches(ext: string, buf: Buffer): boolean {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "png":
      return (
        buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );
    case "gif":
      return buf.length >= 6 && buf.subarray(0, 6).toString("latin1").startsWith("GIF8");
    case "webp":
      return (
        buf.length >= 12 &&
        buf.subarray(0, 4).toString("latin1") === "RIFF" &&
        buf.subarray(8, 12).toString("latin1") === "WEBP"
      );
    case "mp4":
      return buf.length >= 8 && buf.subarray(4, 8).toString("latin1") === "ftyp";
    case "webm":
      return (
        buf.length >= 4 &&
        buf[0] === 0x1a &&
        buf[1] === 0x45 &&
        buf[2] === 0xdf &&
        buf[3] === 0xa3
      );
    default:
      return false;
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminApi();
  if (guard) return guard;

  const csrfOk = await verifyCsrfToken(req);
  if (!csrfOk) return jsonError(403, "CSRF 验证失败");

  const session = await getSession();
  if (!session) return jsonError(401, "未登录或会话已过期");

  // A7 上传端点限流：IP 维度滑动窗口（复用 lib/rate-limit.ts）
  const limit = tryConsumeUpload(getClientIp(req));
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({ error: `上传过于频繁，请 ${limit.retryAfterSec} 秒后再试` }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  let file: File;
  try {
    const formData = await req.formData();
    const picked = formData.get("file");
    if (!(picked instanceof File)) {
      return jsonError(400, "缺少上传文件");
    }
    file = picked;
  } catch {
    return jsonError(400, "请求体不是合法的表单上传");
  }

  // A3 类型白名单：扩展名 + MIME 双重校验，不一致拒收（415）
  const ext = fileExtensionOf(file.name || "");
  const kind = mediaKindByExtension(ext);
  if (!kind) {
    return jsonError(415, "不支持的文件类型：图片仅支持 jpg/png/gif/webp，视频仅支持 mp4/webm");
  }
  const expectedMime = kind === "image" ? imageMimeByExt(ext) : videoMimeByExt(ext);
  const declaredMime = (file.type || "").toLowerCase();
  // image/jpg 是常见的非规范 JPEG MIME，与 image/jpeg 一并放行
  const mimeAliases = ext === "jpg" || ext === "jpeg" ? ["image/jpeg", "image/jpg"] : [expectedMime ?? ""];
  if (!declaredMime || !mimeAliases.includes(declaredMime)) {
    return jsonError(415, "文件 MIME 类型与扩展名不一致，已拒收");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // A4 大小分级（以实际内容字节数为准）
  const maxBytes = kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  const maxLabel = kind === "image" ? "10MB" : "50MB";
  if (buffer.byteLength === 0) {
    return jsonError(400, "空文件无法上传");
  }
  if (buffer.byteLength > maxBytes) {
    return jsonError(413, `文件超过大小上限：${kind === "image" ? "图片" : "视频"}最大 ${maxLabel}`);
  }

  // 魔数与声明扩展名不一致 → 415（防扩展名伪造）
  if (!magicMatches(ext, buffer)) {
    return jsonError(415, "文件内容与扩展名不符，已拒收");
  }

  // A5 落盘：服务端生成文件名，不含任何客户端可控成分
  try {
    const stored = await saveMediaFile(buffer, ext, kind);
    await logAudit({
      adminId: session.id,
      action: AUDIT_ACTIONS.MEDIA_UPLOAD,
      targetType: "media",
      targetId: stored.url,
      metadata: { fileName: stored.fileName, kind, size: buffer.byteLength, mime: declaredMime },
    });
    return new Response(
      JSON.stringify({
        ok: true,
        url: stored.url,
        kind,
        size: buffer.byteLength,
        mime: declaredMime,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    // 不把绝对路径/堆栈返回给客户端（A6）
    console.error("[admin/upload] save failed:", error);
    return jsonError(500, "文件保存失败，请稍后重试");
  }
}

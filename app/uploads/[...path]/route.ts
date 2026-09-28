import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getUploadsRoot, parseUploadsUrl } from "@/lib/media-storage";

/**
 * /uploads/... 静态服务路由（紧急修复 2026-09-28）。
 *
 * 背景：Next.js standalone 模式下 public/ 是构建期 COPY 进镜像的，运行时写入
 * public/uploads 的文件不被静态服务（线上实测 404，文章图片/视频全裂，显示
 * alt 兜底）。媒体文件改落持久化卷 UPLOAD_DIR（/app/uploads），由本路由伺服。
 *
 * 形态与旧的 public 静态托管一致：URL 仍是 /uploads/{images|videos}/{文件名}，
 * 正文 markdown 无需任何改动。
 *
 * 安全：
 *   - 路径穿越防护：先经 parseUploadsUrl 白名单校验（仅 images/videos 两级 +
 *     安全字符文件名），再 resolve 后二次校验必须位于 uploads 根目录内；
 *   - 仅 GET/HEAD；MIME 按白名单扩展名映射（不信任文件内容嗅探，也不信任
 *     请求方声明）。
 */

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** 静态资源缓存：文件名带随机成分，内容不可变，长缓存 + immutable 安全 */
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
};

async function resolveUploadFile(
  segments: string[]
): Promise<{ absolutePath: string; mime: string } | null> {
  // segments 形如 ["images", "20260928-bf34e743.jpg"]
  const url = `/uploads/${segments.join("/")}`;
  const parsed = parseUploadsUrl(url);
  if (!parsed) return null;

  const ext = path.extname(parsed.fileName).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;

  const root = path.resolve(getUploadsRoot());
  const absolutePath = path.resolve(root, parsed.kind === "image" ? "images" : "videos", parsed.fileName);
  // 二次校验：解析后的真实路径必须严格位于 uploads 根目录内（防符号链接/穿越）
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
    return null;
  }
  return { absolutePath, mime };
}

async function handle(req: NextRequest, segments: string[]): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new NextResponse("Method Not Allowed", { status: 405 });
  }
  const resolved = await resolveUploadFile(segments);
  if (!resolved) {
    return new NextResponse("Not Found", { status: 404 });
  }
  let file: Buffer;
  try {
    file = await fs.readFile(resolved.absolutePath);
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
  const body = req.method === "HEAD" ? null : new Uint8Array(file);
  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": resolved.mime,
      "Content-Length": String(file.byteLength),
      "X-Content-Type-Options": "nosniff",
      ...CACHE_HEADERS,
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  return handle(req, segments ?? []);
}

export async function HEAD(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  return handle(req, segments ?? []);
}

/**
 * 媒体文件存储层（M1-补丁1 A/E，服务端专用）。
 *
 * 落盘位置（任务书 A5）：public/uploads/{images|videos}/，Next 运行时按请求
 * 从 public/ 磁盘目录直接以 /uploads/... URL 提供静态服务。
 * 生产持久化由部署侧保证（compose 卷挂载点/entrypoint 配合项见任务报告）；
 * MEDIA_UPLOADS_DIR 环境变量可整体覆盖存储根目录（集成测试指向临时目录）。
 *
 * 安全红线：
 *   - 文件名只由服务端生成 {YYYYMMDD}-{8位随机}.{ext}，绝不采信客户端文件名；
 *   - 对外只暴露 /uploads/... 相对 URL，不返回服务端绝对路径。
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { MediaKind } from "@/lib/media";

export function getUploadsRoot(): string {
  const override = process.env.MEDIA_UPLOADS_DIR?.trim();
  if (override) return path.resolve(process.cwd(), override);
  return path.join(process.cwd(), "public", "uploads");
}

function kindDirName(kind: MediaKind): string {
  return kind === "image" ? "images" : "videos";
}

export function uploadsDirFor(kind: MediaKind): string {
  return path.join(getUploadsRoot(), kindDirName(kind));
}

export function uploadsUrlFor(kind: MediaKind, fileName: string): string {
  return `/uploads/${kindDirName(kind)}/${fileName}`;
}

/** 校验 /uploads/... URL 属于本站媒体目录且不含路径穿越成分（删除联动用） */
export function parseUploadsUrl(url: string): { kind: MediaKind; fileName: string } | null {
  const m = url.match(/^\/uploads\/(images|videos)\/([A-Za-z0-9._-]+)$/);
  if (!m) return null;
  const fileName = m[2];
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  return { kind: m[1] === "images" ? "image" : "video", fileName };
}

/**
 * A5：服务端生成安全文件名 {YYYYMMDD}-{8位随机}.{ext}。
 * 日期取服务器本地时间；随机 4 字节十六进制；ext 由 MIME 白名单推导。
 */
export function generateMediaFileName(ext: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${yyyymmdd}-${randomBytes(4).toString("hex")}.${ext}`;
}

/** 落盘：目录不存在则创建；随机名撞车时重试（上限 5 次，概率可忽略） */
export async function saveMediaFile(
  buffer: Buffer,
  ext: string,
  kind: MediaKind
): Promise<{ fileName: string; url: string; absolutePath: string }> {
  const dir = uploadsDirFor(kind);
  await fs.mkdir(dir, { recursive: true });
  let fileName = "";
  let absolutePath = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    fileName = generateMediaFileName(ext);
    absolutePath = path.join(dir, fileName);
    try {
      await fs.access(absolutePath);
      continue; // 已存在（撞车）→ 换个随机名
    } catch {
      break;
    }
  }
  await fs.writeFile(absolutePath, buffer);
  return { fileName, url: uploadsUrlFor(kind, fileName), absolutePath };
}

/**
 * E2：按 /uploads/... URL 列表删除磁盘文件（不存在则忽略，幂等）。
 * 返回实际删除的 URL 列表（写审计用）。
 */
export async function deleteUploadFilesByUrls(urls: string[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const url of urls) {
    const parsed = parseUploadsUrl(url);
    if (!parsed) continue;
    try {
      await fs.unlink(path.join(uploadsDirFor(parsed.kind), parsed.fileName));
      deleted.push(url);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  return deleted;
}

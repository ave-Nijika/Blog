/**
 * 媒体文件存储层（M1-补丁1 A/E + 紧急修复，服务端专用）。
 *
 * 落盘根目录解析顺序（线上事故修复 2026-09-28）：
 *   1. UPLOAD_DIR（生产 compose 既有约定，指向 uploads-data 持久化卷）
 *   2. MEDIA_UPLOADS_DIR（集成测试用临时目录）
 *   3. public/uploads（本地开发回退）
 *
 * 事故背景：原实现只认 MEDIA_UPLOADS_DIR，线上未设该变量 → 回退写进镜像内
 * public/uploads。Next.js standalone 模式下 public/ 是构建期 COPY 进镜像的，
 * 运行时写入的文件不被静态服务 → 文章图片/视频全部 404（截图确认 alt 兜底）。
 * 同时 media 文件写在容器可写层，容器重建即丢。修复：根目录对齐 UPLOAD_DIR
 * 卷挂载点，并由 app/uploads/[...path] 路由提供静态服务（public 在 standalone
 * 下不可运行时写入，这是 Next.js 的既定行为，不是配置疏漏）。
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
  // 优先生产卷挂载点 UPLOAD_DIR（compose.prod.yml 既有环境变量）
  const uploadDir = process.env.UPLOAD_DIR?.trim();
  if (uploadDir) return path.resolve(process.cwd(), uploadDir);
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

export interface ManagedUploadFile {
  url: string;
  kind: MediaKind;
  fileName: string;
  sizeBytes: number;
  mtime: Date;
}

/**
 * 孤儿巡检的文件枚举（M1-补丁2 A4）。
 * comfy 隔离红线：只遍历 images/ 与 videos/ 两个固定子目录（uploadsDirFor
 * 的构造即如此——comfy/ 在存储根下但从不进入本函数），深度固定两级
 * （kind 目录 → 文件），不递归任何未知子目录；大小/时间取自 stat，
 * 不做任何内容读取。目录不存在视为该类暂无文件（尚未上传过）。
 */
export async function listManagedUploadFiles(): Promise<ManagedUploadFile[]> {
  const kinds: MediaKind[] = ["image", "video"];
  const out: ManagedUploadFile[] = [];
  for (const kind of kinds) {
    const dir = uploadsDirFor(kind);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在/不可读 → 该类暂无文件
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue; // 固定两级：只认文件，不进入子目录
      const st = await fs.stat(path.join(dir, entry.name)).catch(() => null);
      if (!st) continue;
      out.push({
        url: uploadsUrlFor(kind, entry.name),
        kind,
        fileName: entry.name,
        sizeBytes: st.size,
        mtime: st.mtime,
      });
    }
  }
  return out;
}

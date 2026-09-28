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
import { createHash } from "node:crypto";
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
 * 服务端生成安全文件名 {YYYYMMDD}-{sha256前16位}.{ext}（M2-补丁2 C1，
 * 取代 8 位随机）。日期取服务器本地时间；hash 由内容决定——同内容同名
 * （同日上传）即天然去重键；历史 `-8位随机` 文件名继续有效（C3，
 * parseUploadsUrl 文件名规则本就放宽为 [A-Za-z0-9._-]+）。
 */
export function generateMediaFileName(ext: string, contentHash: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${yyyymmdd}-${contentHash}.${ext}`;
}

/**
 * 落盘 + 内容哈希去重（M2-补丁2 C1）：先算 sha256 → 目标文件名命中即复用
 * （返回已有 URL，不落新盘，dedup=true 供调用方写 INFO 日志）；未命中才写盘。
 */
export async function saveMediaFile(
  buffer: Buffer,
  ext: string,
  kind: MediaKind
): Promise<{ fileName: string; url: string; absolutePath: string; dedup: boolean }> {
  const dir = uploadsDirFor(kind);
  await fs.mkdir(dir, { recursive: true });
  const contentHash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const fileName = generateMediaFileName(ext, contentHash);
  const absolutePath = path.join(dir, fileName);
  try {
    await fs.access(absolutePath);
    // 同内容已存在 → 复用（同 URL = 同文件，多处引用共同持有，C2）
    return {
      fileName,
      url: uploadsUrlFor(kind, fileName),
      absolutePath,
      dedup: true,
    };
  } catch {
    // 未命中 → 落新盘
  }
  await fs.writeFile(absolutePath, buffer);
  return { fileName, url: uploadsUrlFor(kind, fileName), absolutePath, dedup: false };
}

/**
 * 生成图片缩略图（M2-补丁2 A1）：最长边 640px、webp 质量 78，落
 * uploads/images/thumb/{同名}.webp（GIF 动图保留动画帧）。
 * 生成失败由调用方决定是否阻塞（上传路径：warn 不阻塞；惰性路径：抛错→404）。
 */
export async function generateImageThumb(
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const sharp = (await import("sharp")).default;
  const thumbDir = path.join(uploadsDirFor("image"), "thumb");
  await fs.mkdir(thumbDir, { recursive: true });
  const base = fileName.replace(/\.[A-Za-z0-9]+$/, "");
  const thumbPath = path.join(thumbDir, `${base}.webp`);
  // animated: true —— GIF 动图缩略图保留全部帧（静态图无影响）
  await sharp(buffer, { animated: true })
    .rotate()
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbPath);
  return thumbPath;
}

/**
 * A2 惰性生成：thumb URL（/uploads/images/thumb/{base}.webp）对应原图存在
 * 但缩略图缺失时，按 basename 在 images 目录内定位原图并生成。
 * fail-closed：base 含路径穿越成分/找不到原图/生成失败 → 返回 null（调用方 404）。
 * 只在 images 目录内活动，comfy/ 永不触碰。
 */
export async function ensureImageThumbForBase(base: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(base) || base.includes("..")) return null;
  const imagesDir = uploadsDirFor("image");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(imagesDir);
  } catch {
    return null;
  }
  // 同名原图：扩展名限定上传白名单（thumb 自身 .webp 也可能是某次上传的
  // 原图——webp 在白名单内，天然支持"webp 原图的 thumb"自嵌套场景）
  const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp"];
  let originalName: string | null = null;
  for (const name of entries) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const nameBase = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();
    if (nameBase === base && IMAGE_EXTS.includes(ext)) {
      originalName = name;
      break;
    }
  }
  if (!originalName) return null;
  try {
    const buffer = await fs.readFile(path.join(imagesDir, originalName));
    return await generateImageThumb(buffer, originalName);
  } catch (error) {
    console.warn("[media-storage] lazy thumb generation failed:", originalName, error);
    return null;
  }
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
    // 派生缩略图顺带清理（M2-补丁2）：纯派生物，原图已删则 thumb 无意义；
    // 不存在则忽略（历史文件/视频本就没有 thumb）
    if (parsed.kind === "image") {
      const base = parsed.fileName.replace(/\.[A-Za-z0-9]+$/, "");
      await fs
        .unlink(path.join(uploadsDirFor("image"), "thumb", `${base}.webp`))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
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

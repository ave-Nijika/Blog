/**
 * 文章媒体纯函数库（M1-补丁1）。
 *
 * 职责：正文 markdown 中媒体块（图片 `![alt](url)` / 视频 `@video[alt](url)`）
 * 的识别、插入、块级移动、删除、URL 提取与渲染前处理。
 * 约束：本模块不得 import 任何 node 内置模块或服务端依赖——它同时被
 * 客户端组件（PostEditor / 渲染组件）与服务端（上传 API / 删除联动）引用，
 * 保持纯函数才可被 node 环境单测（tests/unit/media.test.ts）。
 *
 * 块识别规则（任务书 2.2）：
 *   - 以空行分隔的"块"中，首行以 `![` 或 `@video[` 开头的块是媒体块；
 *   - fenced code block（``` / ~~~ 围栏）内的空行不是块边界、围栏内的
 *     `![xxx](yyy)` 字样不是媒体块——切块前先扫描围栏状态。
 */

export type MediaKind = "image" | "video";

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "webm"] as const;

export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];
export type VideoExtension = (typeof VIDEO_EXTENSIONS)[number];

const IMAGE_MIME_BY_EXT: Record<ImageExtension, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const VIDEO_MIME_BY_EXT: Record<VideoExtension, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
};

export function imageMimeByExt(ext: string): string | null {
  return (IMAGE_MIME_BY_EXT as Record<string, string>)[ext] ?? null;
}

export function videoMimeByExt(ext: string): string | null {
  return (VIDEO_MIME_BY_EXT as Record<string, string>)[ext] ?? null;
}

export function mediaKindByExtension(ext: string): MediaKind | null {
  if (ext in IMAGE_MIME_BY_EXT) return "image";
  if (ext in VIDEO_MIME_BY_EXT) return "video";
  return null;
}

/** 文件扩展名（小写，无点）；无名/无扩展名返回空串 */
export function fileExtensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

/** B5：插入用 alt 默认取文件名去扩展名；无名/纯扩展名（如 ".png"）回退 "image" */
export function altFromFileName(name: string): string {
  const idx = name.lastIndexOf(".");
  const base = idx > 0 ? name.slice(0, idx) : idx === -1 ? name : "";
  const trimmed = base.trim();
  return trimmed || "image";
}

// ---------------------------------------------------------------------------
// 围栏扫描与块切分
// ---------------------------------------------------------------------------

/** 围栏标记行（``` 或 ~~~，≥3 个）；返回标记字符，非围栏行返回 null */
function fenceMarkerOf(line: string): string | null {
  const t = line.trimStart();
  if (t.startsWith("```")) return "`";
  if (t.startsWith("~~~")) return "~";
  return null;
}

/** 逐行标记是否处于围栏内（含围栏起始/结束行本身）。围栏内空行不得当块边界。 */
export function computeFencedLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length).fill(false);
  let openMarker: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = fenceMarkerOf(lines[i]);
    if (openMarker) {
      flags[i] = true;
      // 结束围栏：与开始标记同字符的围栏行（简化：忽略长度与缩进差异）
      if (marker === openMarker) openMarker = null;
    } else if (marker) {
      flags[i] = true;
      openMarker = marker;
    }
  }
  return flags;
}

export interface BodyBlock {
  startLine: number;
  endLine: number; // 闭区间
  lines: string[];
}

/**
 * 把正文切成"块"：围栏内区域视为普通内容行（其中的空行不切分），
 * 围栏外空行是块边界。围栏整体与其相邻的非空行同块（无空行分隔时）。
 */
export function splitBodyBlocks(body: string): BodyBlock[] {
  const lines = body.split("\n");
  const fenced = computeFencedLineFlags(lines);
  const blocks: BodyBlock[] = [];
  let current: BodyBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const isBlank = lines[i].trim() === "" && !fenced[i];
    if (isBlank) {
      current = null;
      continue;
    }
    if (!current) {
      current = { startLine: i, endLine: i, lines: [lines[i]] };
      blocks.push(current);
    } else {
      current.endLine = i;
      current.lines.push(lines[i]);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 媒体块识别
// ---------------------------------------------------------------------------

const IMAGE_BLOCK_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)/;
const VIDEO_BLOCK_RE = /^@video\[([^\]]*)\]\(([^)\s]+)\)/;

export interface MediaBlockInfo {
  /** 所在 BodyBlock 在 splitBodyBlocks 结果中的下标 */
  blockIndex: number;
  kind: MediaKind;
  alt: string;
  url: string;
  startLine: number;
  endLine: number;
  raw: string;
}

/** 首行以 `![` / `@video[` 开头的块为媒体块（围栏内的不算——见 splitBodyBlocks） */
export function findMediaBlocks(body: string): MediaBlockInfo[] {
  const blocks = splitBodyBlocks(body);
  const out: MediaBlockInfo[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const first = block.lines[0].trimStart();
    const video = first.match(VIDEO_BLOCK_RE);
    const image = video ? null : first.match(IMAGE_BLOCK_RE);
    const m = video ?? image;
    if (!m) continue;
    out.push({
      blockIndex: b,
      kind: video ? "video" : "image",
      alt: m[1] ?? "",
      url: m[2] ?? "",
      startLine: block.startLine,
      endLine: block.endLine,
      raw: block.lines.join("\n"),
    });
  }
  return out;
}

/** B1：光标处插入的媒体行（媒体块前后各空一行由 insertMediaAt 保证） */
export function buildMediaSnippet(kind: MediaKind, alt: string, url: string): string {
  const safeAlt = alt.replace(/[[\]]/g, "");
  return kind === "video" ? `@video[${safeAlt}](${url})` : `![${safeAlt}](${url})`;
}

// ---------------------------------------------------------------------------
// 插入 / 移动 / 删除（全部返回新字符串，不改动入参）
// ---------------------------------------------------------------------------

/**
 * 在 position 处插入一个媒体块：媒体块前后各留一个空行（文档边界除外）。
 * 光标在段落中间时，段落会被媒体块分成两段——这正是"控制媒体放在两段中间"。
 */
export function insertMediaAt(body: string, position: number, snippet: string): string {
  const pos = Math.max(0, Math.min(position, body.length));
  const before = body.slice(0, pos);
  const after = body.slice(pos);
  const beforeTrim = before.replace(/\n+$/, "");
  const afterTrim = after.replace(/^\n+/, "");
  const prefix = beforeTrim ? `${beforeTrim}\n\n` : "";
  const suffix = afterTrim ? `\n\n${afterTrim}` : "";
  return `${prefix}${snippet}${suffix}`;
}

/**
 * D2：把第 fromIndex 个媒体块整块移动到第 toIndex 个媒体块的位置
 * （拖拽落下后被拖块成为第 toIndex 个媒体块）。除目标块外其余内容零改动：
 * 只摘除"被拖块 + 一个分隔空行"，再在目标位置原样插回。
 */
export function moveMediaBlockAt(body: string, fromIndex: number, toIndex: number): string {
  const media = findMediaBlocks(body);
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= media.length ||
    toIndex >= media.length
  ) {
    return body;
  }
  const lines = body.split("\n");
  const dragged = media[fromIndex];
  const target = media[toIndex];
  const draggedCount = dragged.endLine - dragged.startLine + 1;

  // 摘除被拖块；随后多带走一个紧邻空行，保证原位置不留多余空行
  const draggedLines = lines.splice(dragged.startLine, draggedCount);
  let removed = draggedCount;
  if (lines[dragged.startLine] === "") {
    lines.splice(dragged.startLine, 1);
    removed += 1;
  } else if (dragged.startLine > 0 && lines[dragged.startLine - 1] === "") {
    // 被拖块原在文档末尾（后面没有空行），改带走前面的空行
    lines.splice(dragged.startLine - 1, 1);
    removed += 1;
  }

  // 目标块在被拖块之后时，其行号整体前移 removed
  const targetStart =
    target.startLine > dragged.startLine ? target.startLine - removed : target.startLine;
  const targetEnd = targetStart + (target.endLine - target.startLine);

  if (fromIndex < toIndex) {
    // 向下移：插到目标块之后（新序列中成为第 toIndex 个媒体块）
    lines.splice(targetEnd + 1, 0, "", ...draggedLines);
  } else {
    // 向上移：插到目标块之前
    lines.splice(targetStart, 0, ...draggedLines, "");
  }
  return lines.join("\n");
}

/**
 * D5：把第 mediaIndex 个媒体块从正文中移除（只动正文，不动服务器文件——
 * 文件清理由删除文章时的引用计数统一负责）。
 */
export function removeMediaBlockAt(body: string, mediaIndex: number): string {
  const media = findMediaBlocks(body);
  if (mediaIndex < 0 || mediaIndex >= media.length) return body;
  const lines = body.split("\n");
  const target = media[mediaIndex];
  const count = target.endLine - target.startLine + 1;
  lines.splice(target.startLine, count);
  if (lines[target.startLine] === "") {
    lines.splice(target.startLine, 1);
  } else if (target.startLine > 0 && lines[target.startLine - 1] === "") {
    lines.splice(target.startLine - 1, 1);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// URL 提取与安全校验
// ---------------------------------------------------------------------------

const MEDIA_SYNTAX_GLOBAL_RE = /(!\[[^\]]*\]|@video\[[^\]]*\])\(([^()\s]+)\)/g;
const UPLOAD_REF_GLOBAL_RE = /\/uploads\/(?:images|videos)\/[A-Za-z0-9._-]+/g;

/**
 * E1：提取正文中引用的本站媒体 URL（`![..](..)` 与 `@video[..](..)`，
 * 围栏内不算）。只取 `/uploads/` 开头的站内路径，外链一律忽略。
 */
export function extractMediaUrls(body: string): string[] {
  const lines = body.split("\n");
  const fenced = computeFencedLineFlags(lines);
  const urls: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    for (const m of lines[i].matchAll(MEDIA_SYNTAX_GLOBAL_RE)) {
      const url = m[2] ?? "";
      if (url.startsWith("/uploads/")) urls.push(url);
    }
  }
  return urls;
}

/**
 * E2 引用计数用的"宽"提取：扫描原始文本中一切 /uploads/{images|videos}/ 文件
 * 引用（含 frontmatter cover、行内图文混排等媒体语法之外的形态）。
 * 引用计数宁可多算不能漏算：多算只是少删文件（安全侧），漏算会误删被引用文件。
 */
export function extractAllUploadReferences(text: string): string[] {
  return [...text.matchAll(UPLOAD_REF_GLOBAL_RE)].map((m) => m[0]);
}

/**
 * 渲染层 URL 协议校验（安全红线 2.3）：只放行站内绝对路径与 https 外链。
 * 拒绝 javascript: / data: / http: / 协议相对地址（//evil.com）。
 */
export function isSafeMediaUrl(url: string): boolean {
  if (url.startsWith("/")) return !url.startsWith("//");
  return url.startsWith("https://");
}

/** 视频渲染判定：上传白名单内的视频扩展名（忽略查询串/锚点） */
export function isVideoUrl(url: string): boolean {
  const bare = url.split(/[?#]/, 1)[0] ?? "";
  return /\.(mp4|webm)$/i.test(bare);
}

// ---------------------------------------------------------------------------
// @video 自定义语法 → 标准 markdown 图片语法（渲染前预处理）
// ---------------------------------------------------------------------------

const VIDEO_SYNTAX_LINE_RE = /@video\[([^\]]*)\]\(([^()\s]+)\)/g;

/**
 * C3：把围栏外的 `@video[alt](url)` 预处理成 `![alt](url)`，交给
 * react-markdown 原生图片管线渲染；components.img 按 URL 扩展名分流到
 * 视频组件。不引入 rehype-raw、不做任何 HTML 字符串拼接（XSS 面不扩大）。
 * 围栏内的语法字样原样保留（文章里可以教学式展示该语法本身）。
 */
export function renderVideoSyntax(body: string): string {
  const lines = body.split("\n");
  const fenced = computeFencedLineFlags(lines);
  return lines
    .map((line, i) => (fenced[i] ? line : line.replace(VIDEO_SYNTAX_LINE_RE, "![$1]($2)")))
    .join("\n");
}

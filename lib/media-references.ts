/**
 * 媒体引用计数（M1-补丁2，服务端专用）。
 *
 * 唯一口径（红线）：识别"一篇文章是否引用了某 uploads 文件"只允许复用
 * lib/media.ts 的 extractAllUploadReferences —— 扫描磁盘 content/posts 全部
 * md 全文（含草稿/私有，含 frontmatter cover）。本模块只做文件枚举与计数，
 * 不新增任何引用识别规则；两套口径 = 误删根因。
 *
 * 保守语义：文章目录不可读时返回 null（引用状态未知），调用方必须按
 * "全部仍被引用"处理（宁可保留不误删）；单个文件读取失败时跳过该文件
 * （与 M1-补丁1 cleanupArticleUploads 语义一致）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getPostsDir } from "@/lib/content-paths";
import { extractAllUploadReferences } from "@/lib/media";

/**
 * 扫描磁盘全部文章 md，返回 uploads URL → 引用次数 的索引。
 * 返回 null 表示文章目录不可读（无法给出任何"零引用"结论）。
 */
export async function buildUploadReferenceIndex(): Promise<Map<string, number> | null> {
  const dir = getPostsDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const index = new Map<string, number>();
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf-8");
      for (const url of extractAllUploadReferences(raw)) {
        index.set(url, (index.get(url) ?? 0) + 1);
      }
    } catch (error) {
      // 单文件读取失败按"未知"跳过（宁可少算引用保留文件，不可误删）
      console.warn("[media-references] read failed, skip:", name, error);
    }
  }
  return index;
}

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
 *
 * excludeSlug（M2-补丁1 B2）：排除 `<slug>.md` 自身的引用——媒体面板/
 * 浮动菜单"彻底删除"时传入正在编辑的文章（其磁盘 md 里的引用不该阻止
 * 删除，否则"图在文档里就永远删不掉"）。不传时行为与 M1-补丁1/2 完全
 * 一致（删文清理、孤儿巡检）。
 */
export async function buildUploadReferenceIndex(
  opts: { excludeSlug?: string } = {}
): Promise<Map<string, number> | null> {
  const dir = getPostsDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const excludeFile = opts.excludeSlug ? `${opts.excludeSlug}.md` : null;
  const index = new Map<string, number>();
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    if (excludeFile && name === excludeFile) continue;
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

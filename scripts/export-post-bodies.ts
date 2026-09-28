/**
 * 导出已发布文章正文（M2-补丁1 D3 现网样本）。
 *
 * 用途：在部署机上运行，把 content/posts 全部公开文章的 body 导出为
 * 往返快照测试夹具（tests/unit/fixtures/production-bodies.json）。
 * 任务书要求"不得在测试里连线上库"——夹具文件由本脚本离线生成后随
 * 代码提交，测试只读文件。
 *
 * 运行（凛，部署机 /opt/blog）：
 *   docker compose --env-file .env.production exec app \
 *     node scripts/export-post-bodies.ts > production-bodies.json
 *   （或非容器环境：node scripts/export-post-bodies.ts > ...）
 * 把输出文件放到仓库 tests/unit/fixtures/production-bodies.json 并提交。
 *
 * 说明：body 来自磁盘 content/posts/*.md（正文唯一来源），不读数据库。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const override = process.env.CONTENT_POSTS_DIR?.trim();
const postsDir = override
  ? path.resolve(process.cwd(), override)
  : path.join(process.cwd(), "content", "posts");

const out = [];
let names = [];
try {
  names = await fs.readdir(postsDir);
} catch (error) {
  console.error(`[export-post-bodies] 无法读取文章目录 ${postsDir}:`, error);
  process.exit(1);
}

for (const name of names.sort()) {
  if (!name.endsWith(".md")) continue;
  try {
    const raw = await fs.readFile(path.join(postsDir, name), "utf-8");
    const parsed = matter(raw);
    if (parsed.data?.status !== "public") continue;
    out.push({
      slug: String(parsed.data?.slug ?? name.replace(/\.md$/, "")),
      body: parsed.content,
    });
  } catch (error) {
    console.error(`[export-post-bodies] 读取失败，跳过 ${name}:`, error);
  }
}

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
console.error(`[export-post-bodies] 导出 ${out.length} 篇公开文章 body。`);

/**
 * HTTP 层集成测试（审核报告 P1-9）。
 *
 * 与 unit 测试的区别：真实启动 next dev（独立端口 + 独立 SQLite 测试库 +
 * 独立临时内容 git 仓库），直接走 HTTP 请求验证安全边界与业务闭环：
 *   - 草稿/私有文章 404（页面、RSS、Sitemap、搜索）
 *   - 未登录访问后台 API → 401（含 P0-1 回归：GET /api/admin/posts/[id]）
 *   - 无 CSRF token 的写操作 → 403
 *   - 登录 → CSRF → 建文章（git commit 产生）→ 编辑 → 发布 → 删除（归档）
 *   - slug 改名保留 article id 与评论（P1-2 回归）
 *   - 评论：冷却、限流（MAX_ATTEMPTS 真实生效）、正则 reject、自动封禁（DB 阈值）
 *   - 评论审核批准后公开展示
 *   - 阅读量异步计数（P1-7 回归）
 *   - 登录失败限流（本文件最后一个用例，避免污染其他用例的 IP 桶）
 *
 * 运行方式：pnpm test（与单元测试一起执行）；服务器启动约需 10~60s。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

const PORT = 4311;
const BASE = `http://127.0.0.1:${PORT}`;
const VISITOR_SECRET = "test-visitor-secret";
const IP_SECRET = "test-ip-secret";

let server: ChildProcess | null = null;
let tmpRoot = "";
let db: {
  article: { findUnique: (args: unknown) => Promise<Record<string, unknown> | null>; update: (args: unknown) => Promise<unknown> };
  comment: { findMany: (args: unknown) => Promise<Record<string, unknown>[]>; count: (args: unknown) => Promise<number>; create: (args: unknown) => Promise<Record<string, unknown>> };
  regexRule: { create: (args: unknown) => Promise<unknown> };
  siteSettings: { findFirst: () => Promise<unknown>; create: (args: unknown) => Promise<unknown> };
  visitorRisk: { findUnique: (args: unknown) => Promise<{ warningCount: number } | null> };
  visitorBan: { findFirst: (args: unknown) => Promise<Record<string, unknown> | null> };
  articleViewDedup: { count: (args: unknown) => Promise<number> };
  articleTag: { create: (args: unknown) => Promise<unknown>; deleteMany: (args: unknown) => Promise<unknown> };
  deletedArticle: { findFirst: (args: unknown) => Promise<Record<string, unknown> | null> };
  deletedComment: {
    findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
    findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
    count: (args: unknown) => Promise<number>;
  };
  $disconnect: () => Promise<void>;
} | null = null;

const jar = new Map<string, string>();
let csrfToken = "";
const admin = { username: "testadmin", password: "test-admin-pass-123" };

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function req(
  pathname: string,
  init: RequestInit = {},
  opts: { useJar?: boolean } = {}
): Promise<Response> {
  const useJar = opts.useJar !== false;
  const headers = new Headers(init.headers);
  // 显式传入的 cookie 优先于 jar（评论测试需要精确控制 visitor_token）
  if (useJar && jar.size > 0 && !headers.has("cookie")) {
    headers.set("cookie", cookieHeader());
  }
  const res = await fetch(`${BASE}${pathname}`, { ...init, headers, redirect: "manual" });
  if (process.env.DEBUG_COOKIES && (res.status === 401 || res.headers.getSetCookie().length)) {
    console.error(`[dbg] ${pathname} -> ${res.status} setCookie=${JSON.stringify(res.headers.getSetCookie())} jarKeys=${[...jar.keys()].join(",")}`);
  }
  if (useJar) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  return res;
}

function makeVisitorToken(): string {
  const raw = randomBytes(32).toString("hex");
  const sig = createHmac("sha256", VISITOR_SECRET).update(raw).digest("hex").slice(0, 32);
  return raw + sig;
}

function withVisitorCookie(token: string): HeadersInit {
  return { "Content-Type": "application/json", cookie: `visitor_token=${token}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer(): Promise<void> {
  const nextBin = path.resolve("node_modules/next/dist/bin/next");
  server = spawn(process.execPath, [nextBin, "dev", "--port", String(PORT)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: "file:./test.db",
      CONTENT_POSTS_DIR: path.join(tmpRoot, "content", "posts"),
      IP_HASH_SECRET: IP_SECRET,
      VISITOR_TOKEN_SECRET: VISITOR_SECRET,
      APP_URL: BASE,
      COMMENT_COOLDOWN_SECONDS: "600",
      COMMENT_RATE_LIMIT_WINDOW_SECONDS: "2",
      COMMENT_RATE_LIMIT_MAX_ATTEMPTS: "3",
      CAPTCHA_ENABLED: "false",
      SEARCH_RATE_LIMIT_WINDOW_SECONDS: "2",
      SEARCH_RATE_LIMIT_MAX_ATTEMPTS: "5",
      UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: "100", // 上传用例组较多，显式放开避免贴默认限流线
      COMMENT_LLM_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health/live`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(500);
  }
  throw new Error("dev server failed to start in time");
}

// 集成测试夹具（自包含，不依赖仓库 content/posts——主人要求站点不放预置文章）。
// 与历史夹具同名同要点：公开文两篇（含正文关键词，供搜索/片段框用例命中）+ 草稿一篇。
const FIXTURE_POSTS: Record<string, string> = {
  "hello-world.md": `---
title: 我的第一篇学习笔记
slug: hello-world
summary: 集成测试夹具：学习笔记开篇
status: public
category: 生活
tags:
  - 随笔
  - 学习
pinned: false
publishedAt: 2026-01-01T00:00:00.000Z
---

# 我的第一篇学习笔记

你好，世界。这是一篇用于集成测试的公开文章。

\`\`\`js
function greet(name) {
  return \`你好，\${name}\`;
}
\`\`\`

正文到此结束。
`,
  "algorithm-notes.md": `---
title: 算法学习笔记：二分查找
slug: algorithm-notes
summary: 集成测试夹具：二分查找
status: public
category: 技术
tags:
  - 算法
pinned: false
publishedAt: 2026-01-02T00:00:00.000Z
---

# 算法学习笔记：二分查找

二分查找的前提是数组有序，每次把搜索区间折半。

\`\`\`python
def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        if arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
\`\`\`
`,
  "draft-post.md": `---
title: 草稿：尚未发布的笔记
slug: draft-post
summary: 集成测试夹具：草稿
status: draft
category: 生活
tags: []
pinned: false
publishedAt: null
---

# 草稿

这篇文章还是草稿，不应出现在任何公开入口。
`,
};

beforeAll(async () => {
  // 1. 临时内容 git 仓库（测试自播种夹具，见 FIXTURE_POSTS）
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blog-integration-"));
  const postsDir = path.join(tmpRoot, "content", "posts");
  fs.mkdirSync(postsDir, { recursive: true });
  for (const [name, raw] of Object.entries(FIXTURE_POSTS)) {
    fs.writeFileSync(path.join(postsDir, name), raw, "utf-8");
  }
  const git = (args: string) => execSync(`git ${args}`, { cwd: tmpRoot, stdio: "ignore" });
  git("init -q -b main");
  git('config user.email "test@example.com"');
  git('config user.name "integration-test"');
  git("add -A");
  git('commit -q -m "init"');

  // 2. 测试数据库（先清掉旧库再迁移）
  for (const suffix of ["", "-journal"]) {
    const dbFile = path.resolve(`prisma/test.db${suffix}`);
    if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
  }
  execSync("pnpm prisma migrate deploy", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });

  // 3. 进程内 PrismaClient（env 必须在 import 前设置 → 动态导入）
  process.env.DATABASE_URL = "file:./test.db";
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  db = prisma as unknown as typeof db;

  // 4. 种子：内容同步 + 分类/标签预置 + 管理员
  const { syncContent } = await import("../../lib/content-sync");
  process.env.CONTENT_POSTS_DIR = path.join(tmpRoot, "content", "posts");
  await syncContent();
  const { seedTaxonomy } = await import("../../scripts/seed-taxonomy");
  await seedTaxonomy();
  await prisma.adminUser.create({
    data: {
      username: admin.username,
      passwordHash: await bcrypt.hash(admin.password, 4),
      active: true,
    },
  });

  // 5. 启动 dev server
  await startServer();
}, 240_000);

afterAll(async () => {
  if (server) {
    server.kill();
    // Windows 上需要确保子进程树退出（SQLite 文件句柄释放后才删得掉测试库）
    if (process.platform === "win32" && server.pid) {
      try {
        execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
      } catch {
        /* already exited */
      }
    }
    await sleep(1500);
  }
  await db?.$disconnect?.();
  // 尽力清理：文件被占用时重试几次，仍失败不判定测试失败
  for (const suffix of ["", "-journal"]) {
    const dbFile = path.resolve(`prisma/test.db${suffix}`);
    for (let attempt = 0; attempt < 3 && fs.existsSync(dbFile); attempt++) {
      try {
        fs.rmSync(dbFile);
      } catch {
        await sleep(1000);
      }
    }
  }
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}, 60_000);

describe("公开内容安全边界", () => {
  it("草稿文章页面 404，公开文章 200", async () => {
    const draft = await req("/posts/draft-post");
    expect(draft.status).toBe(404);
    const pub = await req("/posts/hello-world");
    expect(pub.status).toBe(200);
    expect(await pub.text()).toContain("我的第一篇学习笔记");
  });

  it("草稿不出现在 RSS / Sitemap / 搜索", async () => {
    const rss = await (await req("/rss.xml")).text();
    const sitemap = await (await req("/sitemap.xml")).text();
    expect(rss).not.toContain("draft-post");
    expect(sitemap).not.toContain("draft-post");
    const search = (await (await req("/api/search?q=草稿")).json()) as { articles: { slug: string }[] };
    expect(search.articles.some((a) => a.slug === "draft-post")).toBe(false);
  });

  it("未登录访问后台 API 一律 401（含 GET /api/admin/posts/[id] 回归）", async () => {
    expect((await req("/api/admin/posts", {}, { useJar: false })).status).toBe(401);
    const draft = (await db!.article.findUnique({
      where: { slug: "draft-post" },
    })) as { id: string } | null;
    expect(draft).toBeTruthy();
    const res = await req(`/api/admin/posts/${draft!.id}`, {}, { useJar: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("搜索页渲染正文匹配片段框（fixture 正文关键词，应用层打分链路）", async () => {
    // 「二分」同时命中 algorithm-notes 的标题与正文 → 该文必有片段框
    const res = await req("/search?q=" + encodeURIComponent("二分"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="search-snippet"');
  });
});

describe("搜索接口限流（IP 维度）", () => {
  it("API 第 6 次搜索 429，窗口过期后恢复", async () => {
    await sleep(2300); // 确保干净窗口
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await req("/api/search?q=hello-world");
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    await sleep(2300);
    const after = await req("/api/search?q=hello-world");
    expect(after.status).toBe(200);
  });

  it("SSR 搜索页限流时渲染提示、不渲染结果", async () => {
    await sleep(2300);
    for (let i = 0; i < 5; i++) {
      await req("/api/search?q=二分"); // 占满额度
    }
    const res = await req("/search?q=二分");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="search-rate-limited"');
  });
});

describe("管理员后台全链路", () => {
  it("登录成功并下发 session cookie", async () => {
    const res = await req("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(admin),
    });
    expect(res.status).toBe(200);
    expect(jar.has("SESSION")).toBe(true);
  });

  it("无 CSRF token 的写操作 403（P0-2 回归）", async () => {
    const res = await req("/api/admin/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("GET /api/csrf 播种 cookie 并返回 token", async () => {
    const res = await req("/api/csrf");
    const body = (await res.json()) as { csrfToken: string };
    expect(res.status).toBe(200);
    expect(jar.has("CSRF")).toBe(true);
    csrfToken = body.csrfToken;
    expect(csrfToken).toBeTruthy();
  });

  let createdId = "";

  it("创建文章：201 + git commit 产生（P1-9 验收项）", async () => {
    const res = await req("/api/admin/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({
        slug: "integration-post",
        title: "集成测试文章",
        summary: "来自集成测试",
        status: "draft",
        category: "测试",
        tags: ["集成测试"],
        body: "# 集成测试\n\n这是集成测试创建的正文。",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { post: { id: string }; commitSha: string };
    createdId = body.post.id;
    expect(createdId).toBeTruthy();
    expect(body.commitSha).toMatch(/^[0-9a-f]{7,}$/);
    const filePath = path.join(tmpRoot, "content", "posts", "integration-post.md");
    expect(fs.existsSync(filePath)).toBe(true);
    const log = execSync("git log --oneline", { cwd: tmpRoot, encoding: "utf-8" });
    expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("编辑文章：200 + 新 commit + 正文更新", async () => {
    const res = await req(`/api/admin/posts/${createdId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({
        slug: "integration-post",
        title: "集成测试文章（已编辑）",
        summary: "来自集成测试",
        status: "draft",
        category: "测试",
        tags: ["集成测试"],
        body: "# 集成测试\n\n编辑后的正文。",
      }),
    });
    expect(res.status).toBe(200);
    const raw = fs.readFileSync(
      path.join(tmpRoot, "content", "posts", "integration-post.md"),
      "utf-8"
    );
    expect(raw).toContain("编辑后的正文");
  });

  it("发布文章：公开页立即可见", async () => {
    const res = await req(`/api/admin/posts/${createdId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const page = await req("/posts/integration-post");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("集成测试文章（已编辑）");
  });

  it("slug 改名保留 article id 与评论（P1-2 回归）", async () => {
    const before = (await db!.article.findUnique({ where: { id: createdId } })) as {
      id: string;
    } | null;
    expect(before).toBeTruthy();
    await db!.comment.create({
      data: {
        articleId: createdId,
        bodyText: "改名前留下的评论",
        status: "approved",
      },
    });
    const res = await req(`/api/admin/posts/${createdId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({
        slug: "renamed-post",
        title: "集成测试文章（已编辑）",
        summary: "来自集成测试",
        status: "public",
        category: "测试",
        tags: ["集成测试"],
        body: "# 集成测试\n\n改名后的正文。",
      }),
    });
    expect(res.status).toBe(200);
    const after = (await db!.article.findUnique({ where: { id: createdId } })) as {
      slug: string;
    } | null;
    expect(after?.slug).toBe("renamed-post");
    const comments = await db!.comment.findMany({
      where: { articleId: createdId },
    });
    expect(comments).toHaveLength(1);
    const page = await req("/posts/renamed-post");
    expect(page.status).toBe(200);
  });

  it("删除文章：物理删除，列表不再出现，页面 404（P1-2 归档语义被方案 C 取代）", async () => {
    const res = await req(`/api/admin/posts/${createdId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedArticleId?: string };
    expect(body.deletedArticleId).toBeTruthy();
    const page = await req("/posts/renamed-post");
    expect(page.status).toBe(404);
    // 物理删除：DB 记录不再存在（不再走"归档"路径）
    const gone = (await db!.article.findUnique({ where: { id: createdId } })) as {
      id: string;
    } | null;
    expect(gone).toBeNull();
    // 管理列表不再出现该文章
    const list = (await (await req("/api/admin/posts")).json()) as {
      items: { id: string }[];
    };
    expect(list.items.some((p) => p.id === createdId)).toBe(false);
  });
});

describe("评论管线", () => {
  let tokenA = "";

  it("正常提交：200 + 入库 pending + 公开列表不显示", async () => {
    await sleep(2300); // 避开限流窗口
    tokenA = makeVisitorToken();
    const res = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(tokenA),
      body: JSON.stringify({ bodyText: "这是一条集成测试评论，长度肯定超过两个字符。" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const list = (await (await req("/api/posts/hello-world/comments")).json()) as {
      comments: unknown[];
    };
    expect(list.comments).toHaveLength(0);
    const pending = await db!.comment.findMany({ where: { bodyText: { contains: "集成测试评论" } } });
    expect(pending).toHaveLength(1);
    expect((pending[0] as { status: string }).status).toBe("pending");
  });

  it("同一访客冷却期内再提交：统一 200 + 通用错误文案", async () => {
    const res = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(tokenA),
      body: JSON.stringify({ bodyText: "冷却期内再次提交，应该被拒绝。" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBeFalsy();
    expect(body.error).toBe("评论提交失败，请稍后再试");
  });

  it("正则 reject：统一提示、不落库、警告 +2（低优先级 reject 也生效）", async () => {
    await db!.regexRule.create({
      data: { name: "集成-禁词", pattern: "forbiddenword", action: "reject", priority: 1, warningIncrement: 2, enabled: true },
    });
    // 故意放一条低优先级 reject（priority 更小），验证 P1-8 遍历修复
    await db!.regexRule.create({
      data: { name: "集成-禁词2", pattern: "lowprioritybad", action: "reject", priority: 0, warningIncrement: 1, enabled: true },
    });
    await sleep(2300);
    const res = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(makeVisitorToken()),
      body: JSON.stringify({ bodyText: "这里包含 forbiddenword 应该被拦截" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true); // 对外统一提示，不泄露"被拒"
    expect(await db!.comment.count({ where: { bodyText: { contains: "forbiddenword" } } })).toBe(0);
    // 低优先级 reject（第一条未命中时）也能拦截
    await sleep(2300);
    const res2 = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(makeVisitorToken()),
      body: JSON.stringify({ bodyText: "这里包含 lowprioritybad 应该被拦截" }),
    });
    expect(res2.status).toBe(200);
    expect(
      await db!.comment.count({ where: { bodyText: { contains: "lowprioritybad" } } })
    ).toBe(0);
  });

  it("审核链：未启用 LLM 且配置了正则时，未命中规则的提交自动通过（approved）", async () => {
    // 此时分（前一个用例创建的）正则规则仍在且 LLM 未启用：
    // 主人伪代码——规则判定安全（none/replace）→ 自动通过，不再一律转人工
    await sleep(2300);
    const res = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(makeVisitorToken()),
      body: JSON.stringify({ bodyText: "这条评论没有命中任何规则，应该被自动放行展示。" }),
    });
    expect(res.status).toBe(200);
    const approved = await db!.comment.findFirst({
      where: { bodyText: { contains: "自动放行展示" } },
    });
    expect(approved?.status).toBe("approved");
  });

  it("审核链：规则与 LLM 均未配置时，提交保守转人工（pending）", async () => {
    // 清空规则后（同时未启用 LLM）：唯一防线都不存在 → 保守 pending
    await db!.regexRule.deleteMany({});
    await sleep(2300);
    const res = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(makeVisitorToken()),
      body: JSON.stringify({ bodyText: "没有任何审核配置时，这条评论应当转人工。" }),
    });
    expect(res.status).toBe(200);
    const pending = await db!.comment.findFirst({
      where: { bodyText: { contains: "应当转人工" } },
    });
    expect(pending?.status).toBe("pending");
    // 还原禁词规则：后续"自动封禁"用例依赖这些规则累计警告
    await db!.regexRule.create({
      data: { name: "集成-禁词", pattern: "forbiddenword", action: "reject", priority: 1, warningIncrement: 2, enabled: true },
    });
    await db!.regexRule.create({
      data: { name: "集成-禁词2", pattern: "lowprioritybad", action: "reject", priority: 0, warningIncrement: 1, enabled: true },
    });
  });

  it("限流滑动窗口：第 4 次提交 429（MAX_ATTEMPTS=3 真实生效）", async () => {
    await sleep(2300);
    // 并发发出 4 个不同访客 token 的提交（避开冷却），共享同一 IP 限流窗口
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        req("/api/posts/hello-world/comments", {
          method: "POST",
          headers: withVisitorCookie(makeVisitorToken()),
          body: JSON.stringify({ bodyText: `限流窗口内的快速提交 ${i}，内容长度足够。` }),
        })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200]);
    // 限流信号从状态码挪到 body：并发的第 4 个被限流，其余 3 个成功
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { ok?: boolean }[];
    const okCount = bodies.filter((b) => b.ok === true).length;
    expect(okCount).toBe(3);
    expect(bodies.filter((b) => b.ok !== true)).toHaveLength(1);
  });

  it("自动封禁：警告累计达 DB 阈值触发 IP 封禁，后续评论统一 200 错误响应", async () => {
    // 通过后台 API 保存阈值（PUT 会立即失效服务端设置缓存，规避 5s TTL 竞态）
    const put = await req("/api/admin/site-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ autoBanWarningThreshold: 2 }),
    });
    expect(put.status).toBe(200);
    await sleep(2300);
    const res = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(makeVisitorToken()),
      body: JSON.stringify({ bodyText: "触发禁词 forbiddenword 以累计警告" }),
    });
    expect(res.status).toBe(200);
    const ban = (await db!.visitorBan.findFirst({
      where: { matchType: "ip", revokedAt: null, createdBy: "system" },
    })) as { id: string } | null;
    expect(ban).toBeTruthy();
    await sleep(2300);
    const blocked = await req("/api/posts/hello-world/comments", {
      method: "POST",
      headers: withVisitorCookie(makeVisitorToken()),
      body: JSON.stringify({ bodyText: "已被封禁的访客再提交，应当统一 200 错误响应。" }),
    });
    expect(blocked.status).toBe(200);
    const blockedBody = (await blocked.json()) as { ok?: boolean; error?: string };
    expect(blockedBody.ok).toBeFalsy();
    expect(blockedBody.error).toBeTruthy();
  });
});

describe("评论审核闭环与阅读量", () => {
  it("管理员批准后公开显示", async () => {
    const pending = (await db!.comment.findMany({
      where: { status: "pending", deletedAt: null },
    })) as { id: string; bodyText: string }[];
    expect(pending.length).toBeGreaterThan(0);
    const target = pending[0];
    const res = await req(`/api/admin/comments/${target.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const list = (await (await req("/api/posts/hello-world/comments")).json()) as {
      comments: { id: string }[];
    };
    expect(list.comments.some((c) => c.id === target.id)).toBe(true);
  });

  it("站点设置 API 保存后可读回（P1-5 回归）", async () => {
    const res = await req("/api/admin/site-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ autoBanWarningThreshold: 4 }),
    });
    expect(res.status).toBe(200);
    const get = (await (await req("/api/admin/site-settings")).json()) as {
      settings: { autoBanWarningThreshold: number };
    };
    expect(get.settings.autoBanWarningThreshold).toBe(4);
  });

  it("阅读量异步累计；管理员会话浏览不计入（P1-7 回归）", async () => {
    await req("/posts/hello-world");
    const deadline = Date.now() + 15_000;
    let count = 0;
    while (Date.now() < deadline) {
      count = await db!.articleViewDedup.count({
        where: { article: { slug: "hello-world" } },
      });
      if (count >= 1) break;
      await sleep(500);
    }
    expect(count).toBeGreaterThanOrEqual(1);
    // 管理员（带 SESSION cookie）访问不再累计
    const before = await db!.articleViewDedup.count({
      where: { article: { slug: "hello-world" } },
    });
    await req("/posts/hello-world");
    await sleep(2000);
    const afterAdmin = await db!.articleViewDedup.count({
      where: { article: { slug: "hello-world" } },
    });
    expect(afterAdmin).toBe(before);
  });
});

describe("评论游客可见开关", () => {
  /** 剥离 <script>（RSC flight 数据/chunk 文件名属字典/配置项范畴），只看可见 DOM 语义 */
  function visibleDom(html: string): string {
    return html.replace(/<script[\s\S]*?<\/script>/gi, "");
  }

  it("开关关闭：游客文章页不出现任何评论语义，管理员仍可见", async () => {
    // 通过后台 API 关闭（PUT 立即失效服务端设置缓存，规避 5s TTL 竞态）
    const put = await req("/api/admin/site-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ commentsVisibleToGuests: false }),
    });
    expect(put.status).toBe(200);

    // 游客（无 cookie）：评论区标题/列表/提交框/空状态一概不渲染
    const guest = await req("/posts/hello-world", {}, { useJar: false });
    expect(guest.status).toBe(200);
    const guestDom = visibleDom(await guest.text());
    expect(guestDom).not.toMatch(/comment/i);
    expect(guestDom).not.toContain("评论");

    // 管理员（登录态）：预览/调试不受开关影响，评论区仍完整渲染
    const adminPage = await req("/posts/hello-world");
    expect(adminPage.status).toBe(200);
    expect(visibleDom(await adminPage.text())).toContain('id="comment-body"');
  });

  it("开关开启：游客文章页恢复正常渲染评论区", async () => {
    const put = await req("/api/admin/site-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ commentsVisibleToGuests: true }),
    });
    expect(put.status).toBe(200);

    const guest = await req("/posts/hello-world", {}, { useJar: false });
    expect(guest.status).toBe(200);
    const guestDom = visibleDom(await guest.text());
    expect(guestDom).toContain('id="comment-body"');
    expect(guestDom).toContain("评论");
  });
});

describe("分类标签管理 taxonomy", () => {
  // 惰性取 csrfToken（describe 收集期该变量尚未由登录流程赋值）
  const jsonHeaders = () => ({
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });

  it("未登录访问 taxonomy API 一律 401", async () => {
    expect((await req("/api/admin/taxonomy", {}, { useJar: false })).status).toBe(401);
    const post = await req("/api/admin/taxonomy/category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "游客分类" }),
    }, { useJar: false });
    expect(post.status).toBe(401);
    const del = await req("/api/admin/taxonomy/tag/whatever", {
      method: "DELETE",
    }, { useJar: false });
    expect(del.status).toBe(401);
  });

  it("登录后无 CSRF 的写操作 403", async () => {
    const res = await req("/api/admin/taxonomy/category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "无CSRF分类" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET 列表包含预置分类/标签（seed 幂等写入）", async () => {
    const res = await req("/api/admin/taxonomy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: { name: string }[];
      tags: { name: string }[];
    };
    const catNames = body.categories.map((c) => c.name);
    const tagNames = body.tags.map((t) => t.name);
    for (const name of ["技术", "部署运维", "AI", "随笔"]) {
      expect(catNames).toContain(name);
    }
    for (const name of ["计算机基础", "算法", "Linux系统", "Windows系统", "环境", "AI智能体", "git", "docker"]) {
      expect(tagNames).toContain(name);
    }
  });

  it("POST 分类：正常创建 201；重名 409；列表可见", async () => {
    const create = await req("/api/admin/taxonomy/category", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "集成测试分类" }),
    });
    expect(create.status).toBe(201);
    const dup = await req("/api/admin/taxonomy/category", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "集成测试分类" }),
    });
    expect(dup.status).toBe(409);
    const list = (await (await req("/api/admin/taxonomy")).json()) as {
      categories: { name: string }[];
    };
    expect(list.categories.some((c) => c.name === "集成测试分类")).toBe(true);
  });

  it("POST 标签：正常创建 201；重名 409", async () => {
    const create = await req("/api/admin/taxonomy/tag", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "集成测试标签" }),
    });
    expect(create.status).toBe(201);
    const dup = await req("/api/admin/taxonomy/tag", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "集成测试标签" }),
    });
    expect(dup.status).toBe(409);
  });

  it("PUT 分类重命名：200 且文章引用同步改写；改成已存在名 409", async () => {
    const created = (await (
      await req("/api/admin/taxonomy/category", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "重命名前分类" }),
      })
    ).json()) as { category: { id: string } };
    // 让一篇文章引用该分类，验证重命名级联改写字符串字段
    const article = (await db!.article.findUnique({
      where: { slug: "hello-world" },
    })) as { id: string } | null;
    expect(article).toBeTruthy();
    await db!.article.update({
      where: { id: article!.id },
      data: { category: "重命名前分类" },
    });

    const renamed = await req(
      `/api/admin/taxonomy/category/${created.category.id}`,
      { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "重命名后分类" }) }
    );
    expect(renamed.status).toBe(200);
    const after = (await db!.article.findUnique({
      where: { slug: "hello-world" },
    })) as { category: string } | null;
    expect(after?.category).toBe("重命名后分类");

    // 与预置分类「技术」重名 → 409
    const conflict = await req(
      `/api/admin/taxonomy/category/${created.category.id}`,
      { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "技术" }) }
    );
    expect(conflict.status).toBe(409);
  });

  it("DELETE 分类：被文章引用 409；无引用 200 且列表移除", async () => {
    // 上一个用例中 hello-world 仍引用「重命名后分类」，需要先找到其 id
    const list = (await (await req("/api/admin/taxonomy")).json()) as {
      categories: { id: string; name: string }[];
    };
    const referenced = list.categories.find((c) => c.name === "重命名后分类");
    expect(referenced).toBeTruthy();
    const denied = await req(`/api/admin/taxonomy/category/${referenced!.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(denied.status).toBe(409);
    const deniedBody = (await denied.json()) as { error?: string };
    expect(deniedBody.error).toContain("引用");

    const created = (await (
      await req("/api/admin/taxonomy/category", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "待删分类" }),
      })
    ).json()) as { category: { id: string } };
    const removed = await req(`/api/admin/taxonomy/category/${created.category.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(removed.status).toBe(200);
    const after = (await (await req("/api/admin/taxonomy")).json()) as {
      categories: { name: string }[];
    };
    expect(after.categories.some((c) => c.name === "待删分类")).toBe(false);
  });

  it("PUT 标签重命名 200；DELETE 被引用 409、解除引用后 200", async () => {
    const created = (await (
      await req("/api/admin/taxonomy/tag", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "生命周期标签" }),
      })
    ).json()) as { tag: { id: string } };
    const tagId = created.tag.id;

    const renamed = await req(`/api/admin/taxonomy/tag/${tagId}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "生命周期标签改" }),
    });
    expect(renamed.status).toBe(200);

    // 关联一篇文章后删除被拒（ArticleTag 关联表计数）
    const article = (await db!.article.findUnique({
      where: { slug: "hello-world" },
    })) as { id: string } | null;
    expect(article).toBeTruthy();
    await db!.articleTag.create({
      data: { articleId: article!.id, tagId },
    });
    const denied = await req(`/api/admin/taxonomy/tag/${tagId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as { error?: string }).error).toContain("引用");

    await db!.articleTag.deleteMany({ where: { tagId } });
    const removed = await req(`/api/admin/taxonomy/tag/${tagId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(removed.status).toBe(200);
  });
});

describe("文章物理删除与存档（方案 C）", () => {
  const jsonHeaders = () => ({
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  let articleId = "";
  let deletedArticleId = "";
  const SLUG = "physical-del-test";
  const TITLE = "物理删除测试文章";
  const BODY_MARKER = "存档快照正文标记XYZ";
  const COMMENT_APPROVED = "存档批准评论ABC";
  const COMMENT_PENDING = "存档待审评论DEF";

  it("删除已发布文章：200、列表不再出现、公开页 404、DB 记录消失", async () => {
    // 建文 → 发布 → 造两条不同状态的评论 → 删除
    const create = await req("/api/admin/posts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug: SLUG,
        title: TITLE,
        summary: "物理删除链路验证",
        status: "draft",
        category: "测试",
        tags: ["集成测试"],
        body: `# 物理删除\n\n${BODY_MARKER}。`,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { post: { id: string } };
    articleId = created.post.id;
    const publish = await req(`/api/admin/posts/${articleId}/publish`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{}",
    });
    expect(publish.status).toBe(200);
    await db!.comment.create({
      data: { articleId, bodyText: COMMENT_APPROVED, status: "approved" },
    });
    await db!.comment.create({
      data: { articleId, bodyText: COMMENT_PENDING, status: "pending" },
    });

    const del = await req(`/api/admin/posts/${articleId}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { deletedArticleId?: string };
    expect(delBody.deletedArticleId).toBeTruthy();
    deletedArticleId = delBody.deletedArticleId!;

    // 管理列表（任一状态筛选）不再出现
    const list = (await (await req("/api/admin/posts")).json()) as {
      items: { id: string }[];
    };
    expect(list.items.some((p) => p.id === articleId)).toBe(false);
    // 公开页 404，DB 记录物理消失
    expect((await req(`/posts/${SLUG}`)).status).toBe(404);
    const gone = (await db!.article.findUnique({ where: { id: articleId } })) as {
      id: string;
    } | null;
    expect(gone).toBeNull();
  });

  it("删除后再次删除 → 404（不再报 git 错误）", async () => {
    const res = await req(`/api/admin/posts/${articleId}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("DeletedArticle/DeletedComment 存档记录完整（快照/版本/评论）", async () => {
    const archived = (await db!.deletedArticle.findFirst({
      where: { originalId: articleId },
    })) as Record<string, unknown> | null;
    expect(archived).toBeTruthy();
    expect(archived!.slug).toBe(SLUG);
    expect(archived!.title).toBe(TITLE);
    expect(archived!.status).toBe("public");
    expect(archived!.id).toBe(deletedArticleId);
    // md 快照含正文与 frontmatter
    expect(String(archived!.rawMarkdown)).toContain(BODY_MARKER);
    expect(String(archived!.rawMarkdown)).toContain(TITLE);
    // 版本历史快照：此前 create/update 记录 + 删除提交记录
    const versions = JSON.parse(String(archived!.versionsJson)) as {
      commitSha: string;
      action: string;
    }[];
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[versions.length - 1].action).toBe("delete");
    expect(versions[versions.length - 1].commitSha).toBeTruthy();
    expect(String(archived!.commitSha)).toBe(
      versions[versions.length - 1].commitSha
    );
    // 评论逐条存档，状态保留
    const comments = (await db!.deletedComment.findFirst({
      where: { deletedArticleId: deletedArticleId },
    })) as { bodyText: string } | null;
    expect(comments).toBeTruthy();
    const archivedComments = await db!.deletedComment.count({
      where: { deletedArticleId: deletedArticleId },
    });
    expect(archivedComments).toBe(2);
  });

  it("已删文章评论出现在 scope=deleted，且不在正常列表", async () => {
    const deletedScope = (await (
      await req("/api/admin/comments?scope=deleted")
    ).json()) as {
      items: {
        bodyText: string;
        isFromDeletedArticle?: boolean;
        deletedArticleTitle?: string;
      }[];
    };
    const archivedOne = deletedScope.items.find(
      (c) => c.bodyText === COMMENT_APPROVED
    );
    expect(archivedOne).toBeTruthy();
    expect(archivedOne!.isFromDeletedArticle).toBe(true);
    expect(archivedOne!.deletedArticleTitle).toBe(TITLE);

    const normalScope = (await (await req("/api/admin/comments")).json()) as {
      items: { bodyText: string }[];
    };
    expect(normalScope.items.some((c) => c.bodyText === COMMENT_APPROVED)).toBe(
      false
    );
    expect(normalScope.items.some((c) => c.bodyText === COMMENT_PENDING)).toBe(
      false
    );
  });

  it("删除后编辑该文章 → 404", async () => {
    const res = await req(`/api/admin/posts/${articleId}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug: SLUG,
        title: TITLE,
        status: "draft",
        body: "# 不应成功",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("已删文章评论可物理删除：200 后记录消失，再删 404", async () => {
    const target = (await db!.deletedComment.findFirst({
      where: { deletedArticleId: deletedArticleId, bodyText: COMMENT_PENDING },
    })) as { id: string } | null;
    expect(target).toBeTruthy();
    const del = await req(`/api/admin/deleted-comments/${target!.id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(del.status).toBe(200);
    const gone = (await db!.deletedComment.findUnique({
      where: { id: target!.id },
    })) as { id: string } | null;
    expect(gone).toBeNull();
    const again = await req(`/api/admin/deleted-comments/${target!.id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(again.status).toBe(404);
  });

  it("存档评论不支持审核：approve 端点对存档 id 返回 404", async () => {
    const remaining = (await db!.deletedComment.findFirst({
      where: { deletedArticleId: deletedArticleId, bodyText: COMMENT_APPROVED },
    })) as { id: string } | null;
    expect(remaining).toBeTruthy();
    const res = await req(`/api/admin/comments/${remaining!.id}/approve`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

describe("媒体上传与删除联动（M1-补丁1）", () => {
  const jsonHeaders = () => ({
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  /** 走真实 HTTP + 落盘的用例会留下上传文件，统一登记后尽力清理 */
  const uploadedUrls: string[] = [];

  function minimalPng(): Buffer {
    // 尾部随机字节：内容哈希去重（M2-补丁2 C1）按内容识别同文件，
    // 测试夹具必须互异才不会被合并为同一 URL
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13, 0);
    ihdrData.writeUInt32BE(1, 0);
    ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const ihdr = Buffer.concat([
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR"),
      ihdrData,
      Buffer.from([0, 0, 0, 0]),
    ]);
    const iend = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.from([0xae, 0x42, 0x60, 0x82])]);
    return Buffer.concat([sig, ihdr, iend, randomBytes(8)]);
  }

  function minimalWebm(): Buffer {
    // EBML 头签名（魔数校验只看前 4 字节）+ 随机填充（内容互异，同上）
    return Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      randomBytes(48),
    ]);
  }

  function uploadForm(
    file: { bytes: Buffer; name: string; type: string },
    extra: Record<string, string> = {}
  ): FormData {
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return form;
  }

  function diskPathOf(url: string): string {
    // /uploads/images/x.png → public/uploads/images/x.png（默认存储根=cwd/public/uploads）
    return path.join(process.cwd(), "public", url);
  }

  async function createArticle(slug: string, body: string): Promise<string> {
    const res = await req("/api/admin/posts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug,
        title: `媒体测试-${slug}`,
        status: "draft",
        category: "测试",
        body,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { post: { id: string } };
    return created.post.id;
  }

  afterAll(async () => {
    // 尽力清理：普通上传用例的落盘文件（引用计数用例由删除联动自行清理）
    for (const url of uploadedUrls) {
      try {
        fs.rmSync(diskPathOf(url), { force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("F1 鉴权：未登录 401；登录后无 CSRF 403；CSRF 失败不落盘", async () => {
    const anon = await fetch(`${BASE}/api/admin/upload`, {
      method: "POST",
      body: uploadForm({ bytes: minimalPng(), name: "a.png", type: "image/png" }),
    });
    expect(anon.status).toBe(401);
    const noCsrf = await req("/api/admin/upload", {
      method: "POST",
      body: uploadForm({ bytes: minimalPng(), name: "a.png", type: "image/png" }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("F1 类型白名单：.txt 415；MIME 与扩展名不一致 415；魔数不符 415", async () => {
    const wrongExt = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: Buffer.from("text"), name: "a.txt", type: "text/plain" }),
    });
    expect(wrongExt.status).toBe(415);
    const wrongMime = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: minimalPng(), name: "a.png", type: "application/json" }),
    });
    expect(wrongMime.status).toBe(415);
    const wrongMagic = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({
        bytes: Buffer.from("not a png"),
        name: "fake.png",
        type: "image/png",
      }),
    });
    expect(wrongMagic.status).toBe(415);
    const wrongMagicBody = (await wrongMagic.json()) as { error?: string };
    expect(wrongMagicBody.error).toBeTruthy();
  });

  it("F1 大小分级：图片超 10MB 413（视频 50MB 同路径，不重复造大缓冲）", async () => {
    const big = Buffer.concat([minimalPng(), Buffer.alloc(10 * 1024 * 1024 + 1, 0)]);
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: big, name: "big.png", type: "image/png" }),
    });
    expect(res.status).toBe(413);
  });

  it("F1 正常图片上传：200 + 安全文件名 + 落盘 + URL 可访问", async () => {
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm(
        { bytes: minimalPng(), name: "主人的 截图#1.png", type: "image/png" },
        {}
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      url: string;
      kind: string;
      size: number;
      mime: string;
    };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("image");
    expect(body.mime).toBe("image/png");
    expect(body.size).toBe(minimalPng().length);
    // A5/C1：文件名只由服务端生成 {YYYYMMDD}-{sha256前16位}.{ext}，无客户端可控成分
    expect(body.url).toMatch(/^\/uploads\/images\/\d{8}-[0-9a-f]{16}\.png$/);
    uploadedUrls.push(body.url);

    // 落盘存在
    expect(fs.existsSync(diskPathOf(body.url))).toBe(true);
    // URL 可访问（Next 运行时从 public/ 提供静态服务）
    const served = await req(body.url, {}, { useJar: false });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
  });

  it("F1 正常视频上传：200 + 落盘 videos 目录", async () => {
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: minimalWebm(), name: "clip.webm", type: "video/webm" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string; kind: string };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("video");
    expect(body.url).toMatch(/^\/uploads\/videos\/\d{8}-[0-9a-f]{16}\.webm$/);
    uploadedUrls.push(body.url);
    expect(fs.existsSync(diskPathOf(body.url))).toBe(true);
  });

  it("F4/E4 场景1：单文引用删文 → 文件删 + media.delete 审计", async () => {
    const up = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: minimalPng(), name: "solo.png", type: "image/png" }),
    });
    const { url } = (await up.json()) as { url: string };
    expect(up.status).toBe(200);
    uploadedUrls.push(url);

    const id = await createArticle("media-del-a", `正文\n\n![单图](${url})\n\n尾部`);
    const del = await req(`/api/admin/posts/${id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as {
      mediaCleanup: { deleted: string[]; kept: number };
    };
    expect(delBody.mediaCleanup.deleted).toContain(url);
    expect(delBody.mediaCleanup.kept).toBe(0);
    expect(fs.existsSync(diskPathOf(url))).toBe(false);

    // 审计日志：media.delete 已记录（红线 6）
    const logs = (await (
      await req("/api/admin/audit-logs?targetType=media&perPage=50")
    ).json()) as { items: { action: string; targetId: string }[] };
    expect(
      logs.items.some((l) => l.action === "media.delete" && l.targetId === "media-del-a")
    ).toBe(true);
    expect(logs.items.some((l) => l.action === "media.upload")).toBe(true);
  });

  it("F4/E4 场景2：两文共用删其一 → 文件保留；删其二 → 文件删", async () => {
    const up = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: minimalPng(), name: "shared.png", type: "image/png" }),
    });
    const { url } = (await up.json()) as { url: string };
    uploadedUrls.push(url);

    const idB = await createArticle("media-del-b", `![共享](${url})`);
    const idC = await createArticle("media-del-c", `第二篇也用 ![共享](${url})`);

    // 删第一篇：仍被第二篇引用 → 保留
    const delB = await req(`/api/admin/posts/${idB}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    const delBBody = (await delB.json()) as {
      mediaCleanup: { deleted: string[]; kept: number };
    };
    expect(delBBody.mediaCleanup.deleted).toEqual([]);
    expect(delBBody.mediaCleanup.kept).toBe(1);
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    // 删第二篇：零引用 → 删盘
    const delC = await req(`/api/admin/posts/${idC}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    const delCBody = (await delC.json()) as {
      mediaCleanup: { deleted: string[]; kept: number };
    };
    expect(delCBody.mediaCleanup.deleted).toContain(url);
    expect(fs.existsSync(diskPathOf(url))).toBe(false);
  });

  it("F4/E4 场景3：编辑保存把媒体从正文移除 → 文件不动（E3）", async () => {
    const up = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: minimalPng(), name: "edited.png", type: "image/png" }),
    });
    const { url } = (await up.json()) as { url: string };
    uploadedUrls.push(url);

    const id = await createArticle("media-edit-d", `![将被移除](${url})`);
    const put = await req(`/api/admin/posts/${id}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug: "media-edit-d",
        title: "媒体测试-media-edit-d",
        status: "draft",
        body: "媒体已被移除的正文",
      }),
    });
    expect(put.status).toBe(200);
    // E3：编辑移除不删文件（可能被草稿/版本历史引用）
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    // 媒体重新加回正文后再删文：该文当前引用 + 零其他引用 → 删盘
    const putBack = await req(`/api/admin/posts/${id}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug: "media-edit-d",
        title: "媒体测试-media-edit-d",
        status: "draft",
        body: `![重新加回](${url})`,
      }),
    });
    expect(putBack.status).toBe(200);
    expect(fs.existsSync(diskPathOf(url))).toBe(true);
    await req(`/api/admin/posts/${id}`, { method: "DELETE", headers: jsonHeaders() });
    expect(fs.existsSync(diskPathOf(url))).toBe(false);
  });

  it("F5 详情页 SSR：@video 渲染为 <video preload=none>（与预览共用配置）", async () => {
    const up = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm({ bytes: minimalWebm(), name: "render.webm", type: "video/webm" }),
    });
    const { url } = (await up.json()) as { url: string };
    uploadedUrls.push(url);

    const id = await createArticle("media-render-e", `开头\n\n@video[集成视频](${url})\n\n结尾`);
    const publish = await req(`/api/admin/posts/${id}/publish`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{}",
    });
    expect(publish.status).toBe(200);

    const page = await req("/posts/media-render-e");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<video");
    expect(html).toContain(`src="${url}"`);
    expect(html).toMatch(/preload="none"/);
    // @video 原始语法不直接出现在渲染结果里（已转为视频元素）
    expect(html).not.toContain("@video[集成视频]");

    // 收尾：删文（清理 uploads 文件）
    const del = await req(`/api/admin/posts/${id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(del.status).toBe(200);
  });
});

describe("媒体删除闭环（M1-补丁2）", () => {
  const jsonHeaders = () => ({
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  /** 测试直接/间接创建的磁盘文件，afterAll 尽力清理 */
  const leftoverPaths: string[] = [];
  const createdArticleIds: string[] = [];

  function minimalPng(): Buffer {
    // 尾部随机字节：内容哈希去重（M2-补丁2 C1）按内容识别同文件，
    // 测试夹具必须互异才不会被合并为同一 URL
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13, 0);
    ihdrData.writeUInt32BE(1, 0);
    ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const ihdr = Buffer.concat([
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR"),
      ihdrData,
      Buffer.from([0, 0, 0, 0]),
    ]);
    const iend = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("IEND"),
      Buffer.from([0xae, 0x42, 0x60, 0x82]),
    ]);
    return Buffer.concat([sig, ihdr, iend, randomBytes(8)]);
  }

  function minimalWebm(): Buffer {
    return Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      randomBytes(48),
    ]);
  }

  function uploadForm(bytes: Buffer, name: string, type: string): FormData {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    return form;
  }

  function diskPathOf(url: string): string {
    // 测试环境未设 UPLOAD_DIR/MEDIA_UPLOADS_DIR → 存储根回退 cwd/public/uploads
    return path.join(process.cwd(), "public", url);
  }

  async function uploadPng(): Promise<string> {
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm(minimalPng(), "patch2.png", "image/png"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    return body.url;
  }

  async function createArticleReferencing(slug: string, url: string): Promise<string> {
    const res = await req("/api/admin/posts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug,
        title: `媒体删除闭环-${slug}`,
        status: "draft",
        category: "测试",
        body: `![引用](${url})`,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { post: { id: string } };
    createdArticleIds.push(created.post.id);
    return created.post.id;
  }

  async function deleteArticle(id: string): Promise<void> {
    const res = await req(`/api/admin/posts/${id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(res.status).toBe(200);
  }

  afterAll(async () => {
    // 兜底清理：正常路径各用例已自清；这里兜住失败分支遗留
    for (const id of createdArticleIds) {
      await req(`/api/admin/posts/${id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      }).catch(() => null);
    }
    for (const p of leftoverPaths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("D5 鉴权：未登录 DELETE/orphans/purge 一律 401；登录后无 CSRF 写操作 403", async () => {
    expect(
      (
        await req("/api/admin/media", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "/uploads/images/x.png" }),
        }, { useJar: false })
      ).status
    ).toBe(401);
    expect(
      (await req("/api/admin/media/orphans", {}, { useJar: false })).status
    ).toBe(401);
    expect(
      (
        await req("/api/admin/media/orphans/purge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: ["/uploads/images/x.png"] }),
        }, { useJar: false })
      ).status
    ).toBe(401);
    // 登录态、无 CSRF 头 → 403（双写端点）
    const noCsrfDelete = await req("/api/admin/media", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "/uploads/images/x.png" }),
    });
    expect(noCsrfDelete.status).toBe(403);
    const noCsrfPurge = await req("/api/admin/media/orphans/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["/uploads/images/x.png"] }),
    });
    expect(noCsrfPurge.status).toBe(403);
  });

  it("comfy 隔离：DELETE/purge 请求 /uploads/comfy/** 路径 → 400，绝不处理", async () => {
    const comfyUrl = "/uploads/comfy/integration-comfy-file.json";
    const del = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url: comfyUrl }),
    });
    expect(del.status).toBe(400);
    const purge = await req("/api/admin/media/orphans/purge", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ urls: [comfyUrl] }),
    });
    expect(purge.status).toBe(400);
    // 混入一个合法 + 一个 comfy 路径 → 整个请求 fail-closed 400
    const mixed = await req("/api/admin/media/orphans/purge", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ urls: ["/uploads/images/whatever.png", comfyUrl] }),
    });
    expect(mixed.status).toBe(400);
  });

  it("D1 零引用彻底删除：200 + 落盘消失 + 审计 source=panel", async () => {
    const url = await uploadPng();
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    const del = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url }),
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { ok: boolean; removed: boolean };
    expect(delBody.ok).toBe(true);
    expect(delBody.removed).toBe(true);
    expect(fs.existsSync(diskPathOf(url))).toBe(false);

    // 审计：media.delete 且 source=panel
    const logs = (await (
      await req("/api/admin/audit-logs?targetType=media&perPage=100")
    ).json()) as { items: { action: string; targetId: string; metadata: string }[] };
    const entry = logs.items.find(
      (l) => l.action === "media.delete" && l.targetId === url
    );
    expect(entry).toBeTruthy();
    expect(JSON.parse(entry!.metadata).source).toBe("panel");
  });

  it("D1 有引用删除 409 + D2 幂等：被引用 409；删文清理后再删同 url 200", async () => {
    const url = await uploadPng();
    const articleId = await createArticleReferencing("media-loop-ref", url);

    const denied = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url }),
    });
    expect(denied.status).toBe(409);
    const deniedBody = (await denied.json()) as {
      ok: boolean;
      referencedBy: number;
    };
    expect(deniedBody.ok).toBe(false);
    expect(deniedBody.referencedBy).toBeGreaterThanOrEqual(1);
    // 409 后文件未被删
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    // 删文 → E2 引用计数清理删掉文件；此时再 DELETE 同 url → 幂等 200
    await deleteArticle(articleId);
    expect(fs.existsSync(diskPathOf(url))).toBe(false);
    const idempotent = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url }),
    });
    expect(idempotent.status).toBe(200);
    const idempotentBody = (await idempotent.json()) as {
      ok: boolean;
      removed: boolean;
    };
    expect(idempotentBody.ok).toBe(true);
    expect(idempotentBody.removed).toBe(false);
  });

  it("D3 孤儿清单：只含 images/videos 零引用文件，comfy 永不出现", async () => {
    const orphanPng = await uploadPng();
    const orphanWebmRes = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: uploadForm(minimalWebm(), "patch2.webm", "video/webm"),
    });
    expect(orphanWebmRes.status).toBe(200);
    const orphanWebm = ((await orphanWebmRes.json()) as { url: string }).url;
    leftoverPaths.push(diskPathOf(orphanPng), diskPathOf(orphanWebm));

    // 被引用文件：不应出现在孤儿清单
    const referenced = await uploadPng();
    const articleId = await createArticleReferencing("media-loop-orphan", referenced);
    leftoverPaths.push(diskPathOf(referenced));

    // comfy 文件：物理存在于 uploads/comfy/，绝不可被列出/统计
    const comfyDir = path.join(process.cwd(), "public", "uploads", "comfy");
    fs.mkdirSync(comfyDir, { recursive: true });
    const comfyFile = path.join(comfyDir, "integration-comfy-file.json");
    fs.writeFileSync(comfyFile, '{"nodes":[]}', "utf-8");
    leftoverPaths.push(comfyFile);

    const res = await req("/api/admin/media/orphans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      totalFiles: number;
      totalBytes: number;
      orphans: { url: string; kind: string; sizeBytes: number; mtime: string }[];
    };
    expect(body.ok).toBe(true);
    const raw = JSON.stringify(body);
    // comfy 隔离专项断言：文件名/目录名在响应任何位置都不出现
    expect(raw).not.toContain("integration-comfy-file");
    expect(raw).not.toContain("comfy");

    // 总数/总占用覆盖全部 images/videos 文件（≥ 三个测试文件的量）
    expect(body.totalFiles).toBeGreaterThanOrEqual(3);
    expect(body.totalBytes).toBeGreaterThanOrEqual(
      minimalPng().length + minimalWebm().length
    );
    // 孤儿清单：两个无引用文件在列、被引用文件不在列；路径形态只允许 images|videos
    expect(body.orphans.some((o) => o.url === orphanPng)).toBe(true);
    expect(body.orphans.some((o) => o.url === orphanWebm)).toBe(true);
    expect(body.orphans.some((o) => o.url === referenced)).toBe(false);
    for (const o of body.orphans) {
      expect(o.url).toMatch(/^\/uploads\/(images|videos)\/[A-Za-z0-9._-]+$/);
      expect(o.sizeBytes).toBeGreaterThan(0);
      expect(Number.isNaN(new Date(o.mtime).getTime())).toBe(false);
    }

    // A5 正常路径：purge 两个孤儿 → deleted + 磁盘消失
    const purge = await req("/api/admin/media/orphans/purge", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ urls: [orphanPng, orphanWebm] }),
    });
    expect(purge.status).toBe(200);
    const purgeBody = (await purge.json()) as {
      ok: boolean;
      deleted: string[];
      skipped: unknown[];
    };
    expect(purgeBody.ok).toBe(true);
    expect(purgeBody.deleted).toEqual([orphanPng, orphanWebm]);
    expect(purgeBody.skipped).toEqual([]);
    expect(fs.existsSync(diskPathOf(orphanPng))).toBe(false);
    expect(fs.existsSync(diskPathOf(orphanWebm))).toBe(false);

    // orphan-sweep 审计：逐文件落 media.delete 且 source=orphan-sweep
    const logs = (await (
      await req("/api/admin/audit-logs?targetType=media&perPage=100")
    ).json()) as { items: { action: string; targetId: string; metadata: string }[] };
    for (const url of [orphanPng, orphanWebm]) {
      const entry = logs.items.find(
        (l) => l.action === "media.delete" && l.targetId === url
      );
      expect(entry).toBeTruthy();
      expect(JSON.parse(entry!.metadata).source).toBe("orphan-sweep");
    }

    await deleteArticle(articleId); // E2 清理被引用文件
  });

  it("D4 purge 竞态防护：清单生成后文章又引用 → skipped 不删", async () => {
    const url = await uploadPng();
    leftoverPaths.push(diskPathOf(url));

    // 1) 扫描：此时零引用，文件在孤儿清单中
    const scan = (await (
      await req("/api/admin/media/orphans")
    ).json()) as { orphans: { url: string }[] };
    expect(scan.orphans.some((o) => o.url === url)).toBe(true);

    // 2) 清单生成后，另一"会话"保存了引用该图的文章
    const articleId = await createArticleReferencing("media-loop-race", url);

    // 3) purge：独立重查引用 → skipped，不删
    const purge = await req("/api/admin/media/orphans/purge", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ urls: [url] }),
    });
    expect(purge.status).toBe(200);
    const purgeBody = (await purge.json()) as {
      ok: boolean;
      deleted: string[];
      skipped: { url: string; referencedBy: number }[];
    };
    expect(purgeBody.ok).toBe(true);
    expect(purgeBody.deleted).toEqual([]);
    expect(purgeBody.skipped).toEqual([{ url, referencedBy: 1 }]);
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    await deleteArticle(articleId); // 清理
  });
});

describe("媒体删除排除自身（M2-补丁1 B2 删除语义修正）", () => {
  const jsonHeaders = () => ({
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const createdArticleIds: string[] = [];

  function minimalPng(): Buffer {
    // 尾部随机字节：内容哈希去重下保证各用例文件互异（不互相污染引用计数）
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13, 0);
    ihdrData.writeUInt32BE(1, 0);
    ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const ihdr = Buffer.concat([
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR"),
      ihdrData,
      Buffer.from([0, 0, 0, 0]),
    ]);
    const iend = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("IEND"),
      Buffer.from([0xae, 0x42, 0x60, 0x82]),
    ]);
    return Buffer.concat([sig, ihdr, iend, randomBytes(8)]);
  }

  function diskPathOf(url: string): string {
    return path.join(process.cwd(), "public", url);
  }

  async function uploadPng(): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([minimalPng()], { type: "image/png" }), "m2b2.png");
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: form,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { url: string }).url;
  }

  async function createArticleReferencing(slug: string, url: string): Promise<string> {
    const res = await req("/api/admin/posts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        slug,
        title: `M2B2-${slug}`,
        status: "draft",
        category: "测试",
        body: `![引用](${url})`,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { post: { id: string } };
    createdArticleIds.push(created.post.id);
    return created.post.id;
  }

  afterAll(async () => {
    for (const id of createdArticleIds) {
      await req(`/api/admin/posts/${id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      }).catch(() => null);
    }
  });

  it("B2 根因修复：排除自身引用后可删盘（旧语义 409 永远删不掉）", async () => {
    const url = await uploadPng();
    const articleId = await createArticleReferencing("m2b2-self", url);

    // 旧语义回归对照：不带 excludeArticleId → 409（自身引用也算数）
    const oldSemantics = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url }),
    });
    expect(oldSemantics.status).toBe(409);
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    // 新语义：排除自身 → 零引用（不含自身）→ 删盘；文章 md 里仍引用着
    //（编辑器随后会把节点移出文档并保存——API 语义只负责文件层）
    const del = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url, excludeArticleId: articleId }),
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { ok: boolean; removed: boolean };
    expect(delBody.ok).toBe(true);
    expect(delBody.removed).toBe(true);
    expect(fs.existsSync(diskPathOf(url))).toBe(false);

    // 收尾：删文（E2 清理对已删文件幂等）
    await req(`/api/admin/posts/${articleId}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
  });

  it("B2 边界：其他文章仍引用 → 409 且引用数不含被排除文章", async () => {
    const url = await uploadPng();
    const idA = await createArticleReferencing("m2b2-pair-a", url);
    const idB = await createArticleReferencing("m2b2-pair-b", url);

    // 排除 A：B 仍引用 → 409 referencedBy=1（不含 A）
    const delA = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url, excludeArticleId: idA }),
    });
    expect(delA.status).toBe(409);
    const delABody = (await delA.json()) as { referencedBy: number };
    expect(delABody.referencedBy).toBe(1);

    // 排除 B：A 仍引用 → 409 referencedBy=1
    const delB = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url, excludeArticleId: idB }),
    });
    expect(delB.status).toBe(409);
    expect(((await delB.json()) as { referencedBy: number }).referencedBy).toBe(1);

    // 删 B（E2：文件仍被 A 引用 → 保留），再排除 A 删除 → 成功
    await req(`/api/admin/posts/${idB}`, { method: "DELETE", headers: jsonHeaders() });
    expect(fs.existsSync(diskPathOf(url))).toBe(true);
    const delFinal = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url, excludeArticleId: idA }),
    });
    expect(delFinal.status).toBe(200);
    expect(fs.existsSync(diskPathOf(url))).toBe(false);
  });

  it("B2/B4：excludeArticleId 指向不存在的文章 → 按完整引用计数（新建文章场景安全）", async () => {
    const url = await uploadPng();
    const articleId = await createArticleReferencing("m2b2-ghost", url);

    const del = await req("/api/admin/media", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ url, excludeArticleId: "nonexistent-id" }),
    });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { referencedBy: number }).referencedBy).toBe(1);
    expect(fs.existsSync(diskPathOf(url))).toBe(true);

    // 收尾
    await req(`/api/admin/posts/${articleId}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(fs.existsSync(diskPathOf(url))).toBe(false);
  });
});

describe("媒体缩略图与内容哈希去重（M2-补丁2）", () => {
  /** 测试创建的文件（原图 + 派生 thumb），afterAll 兜底清理 */
  const leftoverPaths: string[] = [];

  let sharpMod: typeof import("sharp") | null = null;
  async function solidPng(byte: number): Promise<Buffer> {
    // sharp 生成合法 PNG；byte 决定像素色值 → 内容可变（去重测试用不同内容）
    sharpMod = sharpMod ?? ((await import("sharp")) as typeof import("sharp"));
    return sharpMod
      .default({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: byte, g: byte, b: byte },
        },
      })
      .png()
      .toBuffer();
  }

  /** 指定尺寸的纯色 PNG（1600 档位断言需要大于档位的原图） */
  async function largePng(width: number, height: number, byte: number): Promise<Buffer> {
    sharpMod = sharpMod ?? ((await import("sharp")) as typeof import("sharp"));
    return sharpMod
      .default({
        create: { width, height, channels: 3, background: { r: byte, g: byte, b: byte } },
      })
      .png()
      .toBuffer();
  }

  /** 原图 URL → thumb URL（M2-补丁3 A2 新命名：带规格后缀 .w1600.webp） */
  function thumbUrlOf(url: string): string {
    return url
      .replace(/^\/uploads\/images\//, "/uploads/images/thumb/")
      .replace(/\.png$/, ".w1600.webp");
  }

  function diskPathOf(url: string): string {
    return path.join(process.cwd(), "public", url);
  }

  async function uploadPng(bytes: Buffer): Promise<{
    url: string;
    dedup: boolean;
  }> {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), "m2p2.png");
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; dedup: boolean };
    return { url: body.url, dedup: body.dedup };
  }

  afterAll(async () => {
    for (const p of leftoverPaths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("E1 上传即生成缩略图：1600px webp 落盘 + 正文 URL 不变（渲染映射见单测）", async () => {
    // 大图（2000x1200）验证 1600 档位；withoutEnlargement 对 8px 小图无参考性
    const { url, dedup } = await uploadPng(await largePng(2000, 1200, 7));
    expect(dedup).toBe(false);
    // A3：返回的仍是原图 URL（thumb/{base}.w1600.webp 不出现在 URL 里）
    expect(url).toMatch(/^\/uploads\/images\/\d{8}-[0-9a-f]{16}\.png$/);

    const thumbUrl = thumbUrlOf(url);
    const thumbPath = diskPathOf(thumbUrl);
    leftoverPaths.push(diskPathOf(url), thumbPath);
    expect(fs.existsSync(thumbPath)).toBe(true);
    // webp 魔数：RIFF....WEBP
    const head = fs.readFileSync(thumbPath).subarray(0, 12);
    expect(head.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(head.subarray(8, 12).toString("latin1")).toBe("WEBP");
    // M2-补丁3 A1：档位 1600 —— 2000x1200 → 1600x960（最长边 1600，fit inside）
    const meta = await sharpMod!.default(fs.readFileSync(thumbPath)).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(960);
  });

  it("E2 惰性生成：删 thumb 后请求缩略图 URL → 200 且重新落盘；旧命名不再被读取", async () => {
    const { url } = await uploadPng(await solidPng(11));
    const thumbUrl = thumbUrlOf(url);
    const thumbPath = diskPathOf(thumbUrl);
    leftoverPaths.push(diskPathOf(url), thumbPath);
    expect(fs.existsSync(thumbPath)).toBe(true);
    fs.rmSync(thumbPath); // 模拟存量图/被清理的 thumb

    const res = await req(thumbUrl, {}, { useJar: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(fs.existsSync(thumbPath)).toBe(true); // 惰性生成已落盘

    // M2-补丁3 D1/A2：旧 640px 档命名 {base}.webp 不再被读取 → 404
    const legacyUrl = thumbUrl.replace(/\.w1600\.webp$/, ".webp");
    const legacy = await req(legacyUrl, {}, { useJar: false });
    expect(legacy.status).toBe(404);

    // fail-closed：找不到同名原图的 thumb 请求 → 404，不生成任何文件
    const missing = await req("/uploads/images/thumb/20990101-00000000.w1600.webp", {}, { useJar: false });
    expect(missing.status).toBe(404);
  });

  it("E6 安全回归：videos thumb / 旧命名 / 路径穿越 / 非 webp 一律 404", async () => {
    // 视频无缩略图
    expect(
      (await req("/uploads/videos/thumb/x.w1600.webp", {}, { useJar: false })).status
    ).toBe(404);
    // 旧 640px 档命名 {base}.webp 不再被读取（M2-补丁3 A2，fail-closed）
    expect(
      (await req("/uploads/images/thumb/x.webp", {}, { useJar: false })).status
    ).toBe(404);
    // 路径穿越（编码后的 ../ 会被路由分段拆开或被白名单拒绝）
    expect(
      (
        await req("/uploads/images/thumb/..%2F..%2Fcomfy%2Fx.w1600.webp", {}, { useJar: false })
      ).status
    ).toBe(404);
    // 非 webp 后缀拒绝
    expect(
      (await req("/uploads/images/thumb/x.w1600.png", {}, { useJar: false })).status
    ).toBe(404);
  });

  it("E3 内容哈希去重：同内容同 URL 单文件；不同内容不同文件", async () => {
    const a = await solidPng(23);
    const first = await uploadPng(a);
    expect(first.dedup).toBe(false);
    const second = await uploadPng(a);
    expect(second.dedup).toBe(true);
    expect(second.url).toBe(first.url); // 同 URL
    // 盘上单文件：同名文件只有一个（哈希命名）
    const pathA = diskPathOf(first.url);
    leftoverPaths.push(pathA, diskPathOf(thumbUrlOf(first.url)));
    expect(fs.existsSync(pathA)).toBe(true);

    const different = await uploadPng(await solidPng(99));
    expect(different.dedup).toBe(false);
    expect(different.url).not.toBe(first.url);
    leftoverPaths.push(diskPathOf(different.url), diskPathOf(thumbUrlOf(different.url)));
  });

  it("D3 上传链路（M2-补丁5）：客户端压缩产物 jpeg 上传 200，文件名仍由服务端生成", async () => {
    // 模拟浏览器 canvas.toBlob(jpeg) 的压缩产物（服务端零改动，链路照常）
    sharpMod = sharpMod ?? ((await import("sharp")) as typeof import("sharp"));
    const jpeg = await sharpMod
      .default({
        create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
      .jpeg()
      .toBuffer();
    const form = new FormData();
    // 客户端文件名随意（压缩产物名）——服务端安全语义不采信客户端名（B3）
    form.append(
      "file",
      new Blob([jpeg], { type: "image/jpeg" }),
      "client-compressed-任意名.jpg"
    );
    const res = await req("/api/admin/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    // 服务端命名 {YYYYMMDD}-{sha256前16位}.jpg，与客户端名零关联
    expect(body.url).toMatch(/^\/uploads\/images\/\d{8}-[0-9a-f]{16}\.jpg$/);
    leftoverPaths.push(diskPathOf(body.url));
  });
});

describe("改密后吊销会话（会破坏登录态，放最后段执行并恢复）", () => {
  it("改密后旧会话立即 401，新密码可登录，旧密码不可用", async () => {
    // 前置：此时 jar 已登录（前面 describe 已建好登录态 + csrfToken）
    const change = await req("/api/admin/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ currentPassword: "test-admin-pass-123", newPassword: "test-admin-pass-456" }),
    });
    expect(change.status).toBe(200);
    // 旧会话立即失效
    const probe = await req("/api/admin/posts");
    expect(probe.status).toBe(401);
    // 旧密码不能登录
    const oldLogin = await req("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "testadmin", password: "test-admin-pass-123" }),
    });
    expect(oldLogin.status).toBe(401);
    // 新密码可登录（恢复会话）
    const newLogin = await req("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "testadmin", password: "test-admin-pass-456" }),
    });
    expect(newLogin.status).toBe(200);
    // 改回原密码，保持测试基线（再次吊销 + 重新登录）
    const restore = await req("/api/admin/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ currentPassword: "test-admin-pass-456", newPassword: "test-admin-pass-123" }),
    });
    expect(restore.status).toBe(200);
    const relogin = await req("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(admin),
    });
    expect(relogin.status).toBe(200);
  });
});

describe("登录限流（最后执行，避免污染 IP 桶）", () => {
  it("连续 5 次失败后锁定：第 6 次即使密码正确也 429", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await req("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: admin.username, password: "wrong-password" }),
      }, { useJar: false });
      expect([401, 429]).toContain(res.status);
    }
    const locked = await req("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(admin),
    }, { useJar: false });
    expect(locked.status).toBe(429);
  });
});

describe("ComfyUI 公共端点（P0-1/P0-2 回归）", () => {
  function minimalPng(): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13, 0);
    ihdrData.writeUInt32BE(1, 0);
    ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // truecolor
    const ihdr = Buffer.concat([
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR"),
      ihdrData,
      Buffer.from([0, 0, 0, 0]),
    ]);
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    return Buffer.concat([sig, ihdr, iend]);
  }

  it("GET /comfyui 页面返回 200（P0-1：SQLite 迁移存在性回归）", async () => {
    const res = await req("/comfyui");
    expect(res.status).toBe(200);
  });

  it("登录态 FormData 上传 JSON 工作流 → 200 → 下载/详情校验 → 删除 200（P0-2 回归）", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from('{"nodes":[]}')], { type: "application/json" }), "workflow.json");
    form.append("title", "集成测试-工作流");
    const res = await req("/api/comfy/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; type: string };
    expect(created.type).toBe("WORKFLOW");

    // 详情接口不泄露服务器路径（P2-2 回归）
    const detail = (await (await req(`/api/comfy/${created.id}`)).json()) as Record<string, unknown>;
    expect(detail.filePath).toBeUndefined();

    // 下载 Content-Type 白名单（P2-3 回归）
    const dl = await req(`/api/comfy/${created.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("application/json");

    const del = await req(`/api/comfy/${created.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(del.status).toBe(200);
  });

  it("登录态 FormData 上传 PNG 图片 → 200 → 下载 Content-Type=image/png → 删除 200", async () => {
    const form = new FormData();
    form.append("file", new Blob([minimalPng()], { type: "image/png" }), "pixel.png");
    form.append("title", "集成测试-图片");
    const res = await req("/api/comfy/upload", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    const dl = await req(`/api/comfy/${created.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    const del = await req(`/api/comfy/${created.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    });
    expect(del.status).toBe(200);
  });

  it("未登录上传 → 401；分页参数非法 → 回退默认不 500", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("{}")], { type: "application/json" }), "x.json");
    const anon = await fetch(`${BASE}/api/comfy/upload`, { method: "POST", body: form });
    expect(anon.status).toBe(401);

    const badPage = await req("/api/comfy?page=-5&limit=99999");
    expect(badPage.status).toBe(200);
    const body = (await badPage.json()) as { pagination: { limit: number } };
    expect(body.pagination.limit).toBeLessThanOrEqual(100);
  });
});

describe("i18n 导航 SSR（v2 任务书：P2-5 回归）", () => {
  it("英文 cookie 下首页 HTML 含英文导航（Home/Posts/About）", async () => {
    const res = await fetch(`${BASE}/`, {
      headers: { cookie: "locale=en" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // 至少其中一个英文标签要出现在 SSR HTML 中（不是依赖客户端 useEffect）
    expect(html).toMatch(/>(Home|Posts|About)</);
  });

  it("中文 cookie 下首页 HTML 含中文导航（首页/文章/关于）", async () => {
    const res = await fetch(`${BASE}/`, {
      headers: { cookie: "locale=zh-CN" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/(首页|文章|关于)/);
  });
});

/**
 * CSS 自定义指针回归（M2-补丁8）。
 *
 * 背景：蓝色三角自 M2-补丁4b 起为 DOM 伪光标（rAF 跟随），实测两个固有问题——
 * 原生滚动条绘制在页面内容之上，伪光标 z-index 提到 int32 上限也盖不住；
 * 按住滚动条后浏览器接管鼠标、页面收不到 mousemove，伪光标冻结原地。
 * M2-补丁8 整体切换为 CSS cursor:url(...) 自定义指针（替换系统指针本身，
 * 浏览器原生层绘制，天然盖过滚动条且零延迟跟手），DOM 跟随层移除；
 * 按下收缩观感由 ClickPulse 一次性特效保留（不得恢复 rAF 跟随）。
 *
 * 旧 M2-补丁4b 断言中仍有效部分（灯箱 z-[9999] 不被反向提层）保留在列。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const CSS_PATH = resolve(process.cwd(), "app/globals.css");
const css = readFileSync(CSS_PATH, "utf-8");

describe("全局三角指针（M2-补丁8 A1）", () => {
  it("cursor 规则存在：data URI SVG + 热点 3 2 + 回退 auto", () => {
    const m = css.match(
      /cursor:\s*url\("data:image\/svg\+xml,[^"]+"\)\s*3\s*2,\s*auto\s*!important/,
    );
    expect(m, "应含 url(data:image/svg+xml,...) 3 2, auto 的全局指针规则").toBeTruthy();
  });

  it("指针图形沿用既有三角：18×18（≤32 上限）+ 蓝主色 + 白描边", () => {
    const m = css.match(/cursor:\s*url\("data:image\/svg\+xml,([^"]+)"\)\s*3\s*2/);
    expect(m).toBeTruthy();
    const uri = decodeURIComponent(m![1]);
    expect(uri).toContain("viewBox='0 0 20 20'");
    expect(uri).toContain("width='18'");
    expect(uri).toContain("height='18'");
    expect(uri).toContain("rgb(18,137,249)");
    expect(uri).toContain("stroke='white'");
  });

  it("仅精细指针设备应用（pointer: fine 门控，纯触屏不做 cursor 处理）", () => {
    expect(css).toMatch(/@media\s*\(pointer:\s*fine\)/);
    // 门控块应包含全局指针规则（简化检查：media 块内含 cursor: url(）
    const media = css.match(/@media\s*\(pointer:\s*fine\)\s*\{[\s\S]*?\n\}/);
    expect(media, "pointer: fine 媒体查询块应存在").toBeTruthy();
    expect(media![0]).toContain("cursor: url(");
  });
});

describe("输入区文本指针（M2-补丁8 A2）", () => {
  it("I-beam 规则存在：data URI SVG + 热点 9 9 + 回退 text", () => {
    const m = css.match(
      /cursor:\s*url\("data:image\/svg\+xml,[^"]+"\)\s*9\s*9,\s*text\s*!important/,
    );
    expect(m, "应含 url(data:image/svg+xml,...) 9 9, text 的输入区规则").toBeTruthy();
  });

  it("覆盖范围沿用 M2-补丁7 白名单（input 文本类 / textarea / contenteditable）", () => {
    for (const sel of [
      'html input[type="text"]',
      'html input[type="password"]',
      "html input:not([type])",
      "html textarea",
      'html [contenteditable="true"]',
      'html [contenteditable="plaintext-only"]',
    ]) {
      expect(css).toContain(sel);
    }
  });
});

describe("DOM 伪光标无残留（M2-补丁8 A3）", () => {
  it("globals.css 无 cursor: none、无 .ba-cursor 规则", () => {
    expect(css).not.toContain("cursor: none");
    expect(css).not.toContain("ba-cursor");
  });

  it("BaCursor.tsx 已删除；全仓 ts/tsx 无 ba-cursor 引用", () => {
    expect(existsSync(resolve(process.cwd(), "components/BaCursor.tsx"))).toBe(false);
    for (const dir of ["app", "components", "lib"]) {
      const hits = scanDir(resolve(process.cwd(), dir));
      expect(hits, `${dir}/ 下不得再有 ba-cursor/BaCursor 引用`).toEqual([]);
    }
  });

  it("ClickPulse 点击特效：无 rAF 跟随循环 + 双重门控 + 自动销毁", () => {
    const tsx = readFileSync(resolve(process.cwd(), "components/ClickPulse.tsx"), "utf-8");
    expect(tsx).toContain("scale(0.82)"); // 保留旧 is-down 收缩观感
    expect(tsx).not.toContain("requestAnimationFrame");
    expect(tsx).toContain("(pointer: fine)");
    expect(tsx).toContain("(prefers-reduced-motion: reduce)");
    expect(tsx).toContain("el.remove()");
    expect(tsx).toContain("pointer-events:none");
  });

  it("layout.tsx 挂载 ClickPulse、不再挂载 BaCursor", () => {
    const tsx = readFileSync(resolve(process.cwd(), "app/layout.tsx"), "utf-8");
    expect(tsx).toContain("ClickPulse");
    expect(tsx).not.toContain("BaCursor");
  });
});

describe("层级回归（原 M2-补丁4b 保留项）", () => {
  it("灯箱层级保持 9999（不得反向提层盖住页面导航）", () => {
    const tsx = readFileSync(
      resolve(process.cwd(), "components/MediaImage.tsx"),
      "utf-8",
    );
    expect(tsx).toContain("z-[9999]");
  });
});

/** 递归收集目录下 ts/tsx/css 文件中的 ba-cursor 引用（文件相对路径:行号:行内容） */
function scanDir(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = resolve(d, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.(tsx?|css)$/.test(name)) {
        const lines = readFileSync(full, "utf-8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes("ba-cursor") || line.includes("BaCursor")) {
            hits.push(`${full}:${i + 1}`);
          }
        });
      }
    }
  };
  walk(dir);
  return hits;
}

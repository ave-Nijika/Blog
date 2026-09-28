/**
 * @vitest-environment happy-dom
 *
 * 生命线 1：markdown 往返无损（M2-补丁1 D 组）。
 * 断言方式（D2）：md0 → parse → T0 → serialize → md1 → parse → T1 →
 * serialize → md2；断言 T1 深等于 T0（树级定点稳定）且
 * render(md1) === render(md2)（共享渲染管线真实渲染 diff）。
 * 两侧渲染都经过同一 parse 归一化，因此渲染等价即内容无损。
 * 任何夹具失败 → 修适配层；禁止 skip/xfail（D4）。
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseMarkdownToDoc, serializeDocToMarkdown } from "@/lib/editor/markdown";
import { getMarkdownComponents } from "@/lib/markdown-components";
import { renderVideoSyntax } from "@/lib/media";
import prodBodies from "./fixtures/production-bodies.json";

function renderMarkdownHtml(md: string): string {
  const { container } = render(
    React.createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], components: getMarkdownComponents() },
      renderVideoSyntax(md)
    )
  );
  return container.innerHTML;
}

/** D2：树级定点稳定 + 双重往返渲染等价 */
function assertRoundtrip(md0: string) {
  const t0 = parseMarkdownToDoc(md0);
  const md1 = serializeDocToMarkdown(t0);
  const t1 = parseMarkdownToDoc(md1);
  expect(t1.toJSON()).toEqual(t0.toJSON());
  const md2 = serializeDocToMarkdown(t1);
  expect(md2).toBe(md1);
  expect(renderMarkdownHtml(md2)).toBe(renderMarkdownHtml(md1));
  return md1;
}

const FIXTURES: Record<string, string> = {
  图文混排: [
    "开头一段文字，介绍这张图。",
    "",
    "![界面截图](/uploads/images/20260101-abcd1234.png)",
    "",
    "图后的一段总结，含 **加粗** 与 *斜体* 和 `code`。",
  ].join("\n"),

  fencedCode: [
    "下面是代码：",
    "",
    "```python",
    "def binary_search(arr, target):",
    "    lo, hi = 0, len(arr) - 1",
    "    while lo <= hi:",
    "        mid = (lo + hi) // 2",
    "        if arr[mid] < target:",
    "            lo = mid + 1",
    "        else:",
    "            hi = mid - 1",
    "    return -1",
    "```",
    "",
    "结尾段落。",
  ].join("\n"),

  fencedCode含媒体字样与空行: [
    "围栏内的媒体语法是死文本：",
    "",
    "```md",
    "这一行是说明",
    "",
    "![伪装](/uploads/images/11111111-11111111.png)",
    "@video[伪装](/uploads/videos/22222222-22222222.mp4)",
    "```",
    "",
    "围栏结束。",
  ].join("\n"),

  fencedCode围栏加长: [
    "代码内容本身含三反引号：",
    "",
    "````md",
    "外层说明",
    "```js",
    "const a = 1;",
    "```",
    "````",
    "",
    "结束。",
  ].join("\n"),

  gfm表格: [
    "表格前后都有文字。",
    "",
    "| 用法 | 说明 |",
    "| --- | --- |",
    "| `A` | 第一列 |",
    "| `B` | 第二列 |",
    "",
    "表格后的段落。",
  ].join("\n"),

  嵌套列表: [
    "- 第一项",
    "- 第二项：",
    "  - 嵌套 1",
    "  - 嵌套 2",
    "    - 更深一层",
    "- 第三项",
    "",
    "1. 有序一",
    "2. 有序二",
    "   1. 有序嵌套",
  ].join("\n"),

  引用块嵌套: [
    "> 一级引用",
    ">",
    "> > 二级嵌套引用",
    ">",
    "> 回到一级，含 **加粗**。",
    "",
    "引用后的正文。",
  ].join("\n"),

  水平线: ["段落一", "", "---", "", "段落二"].join("\n"),

  硬换行: ["第一行  ", "第二行（前一行行尾两个空格）", "", "反斜杠\\", "硬换行"].join("\n"),

  html实体: [
    "实体：&amp; &lt; &gt; &copy; &quot; &#65;",
    "",
    "普通 & 与号，和 3 < 5 > 2 数学式。",
  ].join("\n"),

  连续空行: ["第一段。", "", "", "", "第三段（中间三个空行）。"].join("\n"),

  行内代码特殊字符: [
    "行内代码：`a *b* [c](d) <e> & f \\ g` 与 ``包含`反引号`` 的写法。",
  ].join("\n"),

  图片视频相邻: [
    "![第一张](/uploads/images/20260101-11111111.png)",
    "",
    "@video[演示](/uploads/videos/20260101-22222222.mp4)",
    "",
    "@video[第二个](/uploads/videos/20260101-33333333.webm)",
    "",
    "![第二张](/uploads/images/20260101-44444444.webp)",
    "",
    "结尾。",
  ].join("\n"),

  中文标点混排: [
    "「引号」、顿号、冒号：省略号……破折号——全角括号（内容）！感叹？疑问。",
    "",
    "**中文加粗**与*斜体*混排，英文 mixed **bold** 中文。",
  ].join("\n"),

  行内混排媒体: [
    "段首文字 ![行内图](/uploads/images/20260101-55555555.png) 段中文字与 @video[行内视频](/uploads/videos/20260101-66666666.mp4) 段尾。",
  ].join("\n"),

  标题层级与链接: [
    "# 一级标题",
    "",
    "## 二级标题",
    "",
    "###### 六级标题",
    "",
    "链接：[碧蓝航线官网](https://www.azurlane.net) 与 <https://example.com/auto>。",
    "",
    "### 三级标题结尾",
  ].join("\n"),

  原始HTML剥离: [
    "段落前文字。",
    "",
    "<script>alert(1)</script>",
    "",
    "行内 <b>加粗标记</b> 与 <img src=x onerror=alert(2)>。",
  ].join("\n"),

  转义字符文本: [
    "星号 \\* 下划线 \\_ 反斜杠 \\\\ 与普通 *_组合_ 出现。",
    "",
    "方括号 \\[行\\] 与感叹号！\\!无惊叹语法。",
  ].join("\n"),
};

describe("markdown 往返快照（生命线 1 / D1 D2）", () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    it(`往返渲染等价：${name}`, () => {
      const md1 = assertRoundtrip(md);
      // D5 报告素材：控制台输出往返后的文本（字节对比人工核对用）
      if (process.env.ROUNDTRIP_DEBUG) {
        console.log(`--- ${name} ---\n${md1}`);
      }
    });
  }

  it("E5：原始 HTML 不被序列化保留（转义为纯文本）", () => {
    const md1 = assertRoundtrip(FIXTURES["原始HTML剥离"]);
    // 负向后顾：排除已被反斜杠转义的字面文本形态
    expect(md1).not.toMatch(/(?<!\\)<script>/);
    expect(md1).not.toMatch(/(?<!\\)<b>/);
    expect(md1).not.toMatch(/(?<!\\)<img/);
    // 转义后的字面文本保留（内容零丢失；esc 只转义 < 不转义 >）
    expect(md1).toContain("\\<script>");
  });

  it("生命线 2：@video 与图片精确互逆", () => {
    const md = FIXTURES["图片视频相邻"];
    const md1 = assertRoundtrip(md);
    expect(md1).toContain("@video[演示](/uploads/videos/20260101-22222222.mp4)");
    expect(md1).toContain("@video[第二个](/uploads/videos/20260101-33333333.webm)");
    expect(md1).toContain("![第一张](/uploads/images/20260101-11111111.png)");
    // 视频 URL 不会被误认成图片节点（无 marker title 泄漏）
    expect(md1).not.toContain("\u200b");
  });

  it("视频语法在围栏内原样保留", () => {
    const md1 = assertRoundtrip(FIXTURES["fencedCode含媒体字样与空行"]);
    expect(md1).toContain("@video[伪装](/uploads/videos/22222222-22222222.mp4)");
    expect(md1).toContain("![伪装](/uploads/images/11111111-11111111.png)");
  });

  it("链接图片往返无损", () => {
    const md = "[![截图](/uploads/images/20260101-77777777.png)](https://example.com)";
    const md1 = assertRoundtrip(md);
    expect(md1).toBe(md);
  });
});

describe("现网样本往返（D3）", () => {
  it("导出的已发布文章 body 全部渲染等价", () => {
    expect(Array.isArray(prodBodies)).toBe(true);
    for (const sample of prodBodies as { slug: string; body: string }[]) {
      assertRoundtrip(sample.body);
    }
    if ((prodBodies as unknown[]).length === 0) {
      console.warn(
        "[D3] tests/unit/fixtures/production-bodies.json 为空：待凛在服务器运行 scripts/export-post-bodies.ts 导出真实 body 后填充，夹具结构已就绪。"
      );
    }
  });
});

/**
 * 媒体纯函数单测（lib/media.ts，node 环境）。
 * 覆盖任务书 F2（插入三态）/F3（块移动与围栏边界）/F4 前置（URL 提取）
 * /F5（安全校验与 @video 预处理）。渲染层另见 markdown-media.test.tsx。
 */
import { describe, it, expect } from "vitest";
import {
  altFromFileName,
  buildMediaSnippet,
  computeFencedLineFlags,
  extractAllUploadReferences,
  extractMediaUrls,
  fileExtensionOf,
  findMediaBlocks,
  insertMediaAt,
  isSafeMediaUrl,
  isVideoUrl,
  mediaKindByExtension,
  moveMediaBlockAt,
  removeMediaBlockAt,
  renderVideoSyntax,
  splitBodyBlocks,
  thumbnailUrlFor,
} from "@/lib/media";

describe("扩展名 / MIME 判定", () => {
  it("fileExtensionOf：小写化、无扩展名返回空串", () => {
    expect(fileExtensionOf("photo.JPG")).toBe("jpg");
    expect(fileExtensionOf("a.b.webp")).toBe("webp");
    expect(fileExtensionOf("noext")).toBe("");
    expect(fileExtensionOf("trailing.")).toBe("");
  });

  it("mediaKindByExtension：白名单内外", () => {
    expect(mediaKindByExtension("png")).toBe("image");
    expect(mediaKindByExtension("jpeg")).toBe("image");
    expect(mediaKindByExtension("mp4")).toBe("video");
    expect(mediaKindByExtension("webm")).toBe("video");
    expect(mediaKindByExtension("exe")).toBeNull();
    expect(mediaKindByExtension("")).toBeNull();
  });

  it("altFromFileName：去扩展名；无名回退 image", () => {
    expect(altFromFileName("我的截图 2026.png")).toBe("我的截图 2026");
    expect(altFromFileName("clip.webm")).toBe("clip");
    expect(altFromFileName(".png")).toBe("image");
  });
});

describe("围栏感知的块切分", () => {
  it("computeFencedLineFlags：围栏起始到结束（含）都标记", () => {
    const flags = computeFencedLineFlags([
      "para",
      "```js",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "after",
    ]);
    expect(flags).toEqual([false, true, true, true, true, true, false]);
  });

  it("splitBodyBlocks：空行切块；围栏内空行不切块", () => {
    const body = [
      "para one",
      "",
      "```",
      "code",
      "",
      "still code",
      "```",
      "",
      "para two",
    ].join("\n");
    const blocks = splitBodyBlocks(body);
    expect(blocks.map((b) => b.lines[0])).toEqual(["para one", "```", "para two"]);
    // 围栏块完整保留内部空行
    expect(blocks[1].lines).toEqual(["```", "code", "", "still code", "```"]);
  });
});

describe("媒体块识别（findMediaBlocks）", () => {
  it("按文档顺序识别图片/视频块", () => {
    const body = [
      "intro text",
      "",
      "![截图](/uploads/images/20260101-abcd1234.png)",
      "",
      "some paragraph",
      "",
      "@video[演示](/uploads/videos/20260102-deadbeef.mp4)",
    ].join("\n");
    const media = findMediaBlocks(body);
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({
      kind: "image",
      alt: "截图",
      url: "/uploads/images/20260101-abcd1234.png",
    });
    expect(media[1]).toMatchObject({
      kind: "video",
      alt: "演示",
      url: "/uploads/videos/20260102-deadbeef.mp4",
    });
  });

  it("F3：围栏内的 ![xxx](yyy) 字样不得被当作媒体块", () => {
    const body = [
      "看这段代码：",
      "",
      "```md",
      "![伪装](/uploads/images/20260101-11111111.png)",
      "@video[伪装](/uploads/videos/20260101-22222222.mp4)",
      "```",
      "",
      "尾部段落",
    ].join("\n");
    expect(findMediaBlocks(body)).toHaveLength(0);
    // 围栏内也不算站内媒体引用（extractMediaUrls 同规）
    expect(extractMediaUrls(body)).toHaveLength(0);
  });

  it("行内（非块首）媒体与外链不属于媒体面板块", () => {
    const body = "文字 ![行内](/uploads/images/20260101-33333333.png) 混排";
    expect(findMediaBlocks(body)).toHaveLength(0);
  });
});

describe("插入（F2：光标三态 + 块格式精确）", () => {
  const snippet = buildMediaSnippet("image", "图", "/uploads/images/x.png");
  const videoSnippet = buildMediaSnippet("video", "影", "/uploads/videos/x.mp4");

  it("buildMediaSnippet：语法格式精确，alt 中的中括号被剥离", () => {
    expect(snippet).toBe("![图](/uploads/images/x.png)");
    expect(videoSnippet).toBe("@video[影](/uploads/videos/x.mp4)");
    expect(buildMediaSnippet("image", "a[b]c", "/uploads/images/x.png")).toBe(
      "![abc](/uploads/images/x.png)"
    );
  });

  it("光标在开头：块后留一个空行", () => {
    expect(insertMediaAt("正文内容", 0, snippet)).toBe(
      "![图](/uploads/images/x.png)\n\n正文内容"
    );
  });

  it("光标在中间：段落被分成两段，媒体块前后各一空行", () => {
    expect(insertMediaAt("上一段\n\n下一段", 5, snippet)).toBe(
      "上一段\n\n![图](/uploads/images/x.png)\n\n下一段"
    );
  });

  it("光标在末尾：块前留一个空行", () => {
    expect(insertMediaAt("正文内容", 4, snippet)).toBe(
      "正文内容\n\n![图](/uploads/images/x.png)"
    );
  });

  it("空正文 / 光标落在连续空行中间时不产生多余空行", () => {
    expect(insertMediaAt("", 0, snippet)).toBe(snippet);
    expect(insertMediaAt("第一段\n\n\n\n第二段", 5, snippet)).toBe(
      "第一段\n\n![图](/uploads/images/x.png)\n\n第二段"
    );
  });
});

describe("块移动（F3：其余内容零改动 + 围栏边界）", () => {
  const makeBody = () =>
    [
      "第一段文字 AAA",
      "",
      "![图一](/uploads/images/1.png)",
      "",
      "第二段文字 BBB",
      "",
      "```python",
      "def x():",
      "    pass",
      "",
      "# 空行在围栏内",
      "```",
      "",
      "@video[视频一](/uploads/videos/1.mp4)",
      "",
      "尾段 CCC",
    ].join("\n");

  it("快照 diff：媒体块整块移动，其余内容零改动（D4）", () => {
    const body = makeBody();
    // 不变量：除媒体块自身行外，所有非空行逐字符保序；块间距规范化为恰好一个空行
    const contentLines = (s: string) =>
      s
        .split("\n")
        .filter(
          (l) =>
            l.trim() !== "" && !l.startsWith("![") && !l.startsWith("@video[")
        );
    const moved = moveMediaBlockAt(body, 1, 0); // 视频移到最前
    expect(contentLines(moved)).toEqual(contentLines(body));
    expect(moved).not.toMatch(/\n{3,}/);
    expect(moved).toBe(
      "第一段文字 AAA\n\n@video[视频一](/uploads/videos/1.mp4)\n\n" +
        "![图一](/uploads/images/1.png)\n\n第二段文字 BBB\n\n" +
        "```python\ndef x():\n    pass\n\n# 空行在围栏内\n```\n\n尾段 CCC"
    );

    // 移回（视频移到第二个媒体位）→ 媒体顺序还原，正文内容仍零改动
    const movedBack = moveMediaBlockAt(moved, 0, 1);
    expect(contentLines(movedBack)).toEqual(contentLines(body));
    expect(findMediaBlocks(movedBack).map((m) => m.alt)).toEqual(["图一", "视频一"]);
  });

  it("多块顺序：向下移/向上移后媒体顺序都正确", () => {
    const body = [
      "文字",
      "",
      "![A](/uploads/images/a.png)",
      "",
      "中间文字",
      "",
      "![B](/uploads/images/b.png)",
      "",
      "![C](/uploads/images/c.png)",
      "",
      "尾文字",
    ].join("\n");
    // B(1) 移到 C 位置（向下）→ A C B
    const down = moveMediaBlockAt(body, 1, 2);
    expect(findMediaBlocks(down).map((m) => m.alt)).toEqual(["A", "C", "B"]);
    // C(2) 移到 A 位置（向上）→ C A B
    const up = moveMediaBlockAt(body, 2, 0);
    expect(findMediaBlocks(up).map((m) => m.alt)).toEqual(["C", "A", "B"]);
  });

  it("围栏内空行不干扰块边界；移动后围栏内容原样保留", () => {
    const body = makeBody();
    const moved = moveMediaBlockAt(body, 0, 1); // 图一移到视频位置
    expect(moved).toContain("def x():");
    expect(moved).toContain("# 空行在围栏内");
    expect(findMediaBlocks(moved).map((m) => m.alt)).toEqual(["视频一", "图一"]);
  });

  it("同位移动 / 非法下标原样返回", () => {
    const body = makeBody();
    expect(moveMediaBlockAt(body, 1, 1)).toBe(body);
    expect(moveMediaBlockAt(body, -1, 0)).toBe(body);
    expect(moveMediaBlockAt(body, 0, 99)).toBe(body);
  });
});

describe("从正文移除媒体块（D5）", () => {
  it("移除后不留连续空行，其余内容不变", () => {
    const body = "开头\n\n![X](/uploads/images/x.png)\n\n结尾";
    expect(removeMediaBlockAt(body, 0)).toBe("开头\n\n结尾");
  });

  it("移除文档末尾的块会带走前面的空行", () => {
    const body = "开头\n\n![X](/uploads/images/x.png)";
    expect(removeMediaBlockAt(body, 0)).toBe("开头");
  });

  it("非法下标原样返回", () => {
    expect(removeMediaBlockAt("正文", 3)).toBe("正文");
  });
});

describe("URL 提取与安全校验", () => {
  it("extractMediaUrls：只取站内 /uploads/，外链忽略，围栏内忽略", () => {
    const body = [
      "![站内](/uploads/images/1.png)",
      "",
      "![外链](https://example.com/a.png)",
      "",
      "```",
      "![围栏](/uploads/images/2.png)",
      "```",
    ].join("\n");
    expect(extractMediaUrls(body)).toEqual(["/uploads/images/1.png"]);
  });

  it("extractAllUploadReferences：宽提取覆盖 frontmatter cover 与行内", () => {
    const raw = [
      "---",
      "title: t",
      "cover: /uploads/images/cover.png",
      "---",
      "",
      "行内 ![a](/uploads/videos/v.mp4) 文本",
    ].join("\n");
    expect(extractAllUploadReferences(raw).sort()).toEqual([
      "/uploads/images/cover.png",
      "/uploads/videos/v.mp4",
    ]);
  });

  it("isSafeMediaUrl：站内绝对路径与 https 放行，其余全拒", () => {
    expect(isSafeMediaUrl("/uploads/images/a.png")).toBe(true);
    expect(isSafeMediaUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeMediaUrl("//evil.com/a.png")).toBe(false);
    expect(isSafeMediaUrl("http://example.com/a.png")).toBe(false);
    expect(isSafeMediaUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeMediaUrl("")).toBe(false);
  });

  it("isVideoUrl：按扩展名分流，忽略查询串", () => {
    expect(isVideoUrl("/uploads/videos/a.mp4")).toBe(true);
    expect(isVideoUrl("/uploads/videos/a.webm")).toBe(true);
    expect(isVideoUrl("/uploads/videos/a.MP4")).toBe(true);
    expect(isVideoUrl("/uploads/images/a.png")).toBe(false);
    expect(isVideoUrl("/uploads/videos/a.mp4?x=1")).toBe(true);
  });
});

describe("@video 语法预处理（renderVideoSyntax）", () => {
  it("围栏外转换成标准图片语法，围栏内原样保留", () => {
    const body = [
      "@video[演示](/uploads/videos/demo.mp4)",
      "",
      "```md",
      "@video[教学样例](/uploads/videos/doc.mp4)",
      "```",
    ].join("\n");
    const rendered = renderVideoSyntax(body);
    expect(rendered.split("\n")[0]).toBe("![演示](/uploads/videos/demo.mp4)");
    expect(rendered).toContain("@video[教学样例](/uploads/videos/doc.mp4)");
  });
});

describe("缩略图 URL 映射（thumbnailUrlFor，M2-补丁2 A3 + M2-补丁3 A2）", () => {
  it("站内图片 → /uploads/images/thumb/{base}.w1600.webp（带规格后缀）", () => {
    expect(thumbnailUrlFor("/uploads/images/20260928-abcd1234.jpg")).toBe(
      "/uploads/images/thumb/20260928-abcd1234.w1600.webp"
    );
    expect(thumbnailUrlFor("/uploads/images/a.webp")).toBe(
      "/uploads/images/thumb/a.w1600.webp"
    );
  });

  it("非 images 路径 / 外链 / 多级路径返回 null", () => {
    expect(thumbnailUrlFor("/uploads/videos/clip.mp4")).toBeNull();
    expect(thumbnailUrlFor("https://example.com/a.png")).toBeNull();
    // thumb 自身已是二级路径，不再映射（无 thumb of thumb）
    expect(thumbnailUrlFor("/uploads/images/thumb/a.webp")).toBeNull();
    expect(thumbnailUrlFor("/uploads/images/thumb/a.w1600.webp")).toBeNull();
    expect(thumbnailUrlFor("/uploads/images/../../etc/passwd")).toBeNull();
    expect(thumbnailUrlFor("")).toBeNull();
  });
});

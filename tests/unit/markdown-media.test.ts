/**
 * @vitest-environment happy-dom
 *
 * 媒体渲染管线测试（任务书 F5）：编辑页预览与文章详情页共用的
 * getMarkdownComponents() + renderVideoSyntax 组合，用真实 react-markdown
 * 渲染断言：@video 产出受控 <video>、图片走并发限流组件、危险协议 URL
 * 没有任何到达 DOM 的路径、裸 HTML 不被注入。详情页（RSC）同一配置的
 * 端到端验证在 tests/integration/api.test.ts（文章页 SSR 含 <video）。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getMarkdownComponents } from "@/lib/markdown-components";
import { renderVideoSyntax } from "@/lib/media";

// BaLazyImage 依赖 IntersectionObserver：测试桩——observe() 时即视为进入视口
// （与真实浏览器一致：回调异步于构造），使 shouldLoad 置真、真实 <img> 渲染出来。
class IOAutoIntersect {
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(private cb: IntersectionObserverCallback) {}
  observe(): void {
    this.cb(
      [{ isIntersecting: true } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeAll(() => {
  if (typeof globalThis.IntersectionObserver === "undefined") {
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = IOAutoIntersect;
  } else {
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = IOAutoIntersect;
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMarkdown(body: string, enhanceCodeBlock = false) {
  return render(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: getMarkdownComponents({ enhanceCodeBlock }),
      },
      renderVideoSyntax(body)
    )
  );
}

describe("共享渲染配置：@video 与图片（F5）", () => {
  it("@video[alt](url) 渲染为受控 video 元素（controls + preload=none + src）", () => {
    const { container } = renderMarkdown(
      "@video[演示视频](/uploads/videos/20260101-abcd1234.mp4)"
    );
    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.getAttribute("controls")).not.toBeNull();
    expect(video!.getAttribute("preload")).toBe("none");
    expect(video!.getAttribute("src")).toBe("/uploads/videos/20260101-abcd1234.mp4");
  });

  it("站内图片渲染真实 <img>（缩略图），点击灯箱 blur-up 秒开缩略图（M2-补丁2 D1 + M2-补丁5 A1）", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})) // 原图 fetch 保持 pending：只验秒开层
    );
    const { container } = renderMarkdown(
      "![截图](/uploads/images/20260101-abcd1234.png)"
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    // 默认展示走缩略图（thumbnailUrlFor 映射；缺失时由 /uploads 路由惰性生成；
    // M2-补丁3 A2 新命名带规格后缀 .w1600）
    expect(img!.getAttribute("src")).toBe(
      "/uploads/images/thumb/20260101-abcd1234.w1600.webp"
    );
    expect(img!.getAttribute("alt")).toBe("截图");
    fireEvent.click(img!);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // M2-补丁5：灯箱打开瞬间渲染已缓存的 w1600 缩略图（blur-up 零等待），
    // 原图经后台 fetch（AbortController）就绪后淡入——时序细节见 media-ui 单测
    const lightboxThumb = dialog!.querySelector('[data-testid="lightbox-thumb"]');
    expect(lightboxThumb).toBeTruthy();
    expect(lightboxThumb!.getAttribute("src")).toBe(
      "/uploads/images/thumb/20260101-abcd1234.w1600.webp"
    );
    // 点击遮罩关闭
    fireEvent.click(dialog!);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("D1：视频/外链图片不映射缩略图（直接原图）", () => {
    const { container } = renderMarkdown(
      "![外链](https://example.com/a.png)"
    );
    const img = container.querySelector("img");
    expect(img!.getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("段落内的行内图片不破坏 <p> 结构（span 行内包装，无 div 进 p）", () => {
    const { container } = renderMarkdown(
      "前文 ![行内图](/uploads/images/inline.png) 后文"
    );
    expect(container.querySelector("p")).toBeTruthy();
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("javascript: / data: URL 被拒：不渲染 img/video，无危险属性到达 DOM", () => {
    const { container } = renderMarkdown(
      [
        "![坏](javascript:alert(1))",
        // 无调用括号的 javascript: URL 会被 @video 预处理转换，同样必须被拒
        "@video[坏](javascript:alert)",
        "![数据](data:image/png;base64,AAAA)",
      ].join("\n")
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("data:image");
    // 三个媒体语法全部渲染为降级占位
    expect(screen.getAllByRole("note").length).toBe(3);
  });

  it("裸 <video>/<script> HTML 不被注入执行路径（无 rehype-raw）", () => {
    const { container } = renderMarkdown(
      '<video src="https://evil.com/x.mp4"></video><script>alert(1)</script>'
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("C1：同一工厂按 enhanceCodeBlock 开关 pre 增强（详情页 true / 预览 false）", () => {
    const previewCfg = getMarkdownComponents();
    const detailCfg = getMarkdownComponents({ enhanceCodeBlock: true });
    expect(previewCfg.pre).toBeUndefined();
    expect(typeof detailCfg.pre).toBe("function");
    // img 组件两处共用同一工厂产出
    expect(typeof previewCfg.img).toBe("function");
    expect(typeof detailCfg.img).toBe("function");
  });
});

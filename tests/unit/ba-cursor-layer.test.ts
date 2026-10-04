/**
 * 自定义光标回归（M2-补丁4b + M2-补丁7）。
 *
 * M2-补丁4b：.ba-cursor（蓝三角自定义光标）原 z-index 9999 与 MediaLightbox
 * （z-[9999]，portal 在 body 末尾）同层，按 DOM 序灯箱后绘制盖住三角——
 * 主人观感"光标沉到图片下面"。修复提到 int32 上限，静态断言该值
 * 恒大于灯箱层级，防止未来回归。
 *
 * M2-补丁7：文本形态（原生 I-beam 例外移除 + 伪光标形态切换）与
 * 热点对齐三角尖端（TRI_TIP_OFFSET 视觉偏移 + transform-origin 尖端锚）。
 */
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTextTarget } from "@/components/BaCursor";

const CSS_PATH = resolve(process.cwd(), "app/globals.css");
const CURSOR_PATH = resolve(process.cwd(), "components/BaCursor.tsx");

describe(".ba-cursor 层级回归（M2-补丁4b）", () => {
  it("z-index 高于 MediaLightbox 的 9999（int32 上限）", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    const m = css.match(/\.ba-cursor\s*\{[^}]*z-index:\s*(\d+)/);
    expect(m, ".ba-cursor 规则应存在且含 z-index").toBeTruthy();
    const z = Number.parseInt(m![1], 10);
    expect(z).toBeGreaterThan(9999);
    expect(z).toBeLessThanOrEqual(2147483647);
  });

  it("灯箱层级保持 9999（不得反向提层盖住页面导航）", () => {
    const tsx = readFileSync(
      resolve(process.cwd(), "components/MediaImage.tsx"),
      "utf-8"
    );
    expect(tsx).toContain("z-[9999]");
  });
});

describe("光标文本形态（M2-补丁7 需求 1）", () => {
  it("原生 I-beam 例外已移除：输入元素不再命中 cursor:text", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    // 形如 html.ba-cursor-active input { cursor: text !important } 的例外块不得回归
    expect(css).not.toMatch(/html\.ba-cursor-active\s+(?:input|textarea|select)[^{]*\{[^}]*cursor:\s*text/);
  });

  it("globals.css 含文本形态切换规则（.is-text 交叉淡化）", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    expect(css).toContain(".ba-cursor.is-text .ba-cursor-tri");
    expect(css).toContain(".ba-cursor.is-text .ba-cursor-beam");
    // 两形态 SVG 叠放（grid 同格）
    expect(css).toContain("grid-area: 1 / 1");
  });

  it("isTextTarget：文本类 input / textarea / contenteditable 命中", () => {
    const input = document.createElement("input");
    input.type = "text";
    expect(isTextTarget(input)).toBe(true);

    const noType = document.createElement("input");
    expect(isTextTarget(noType)).toBe(true);

    expect(isTextTarget(document.createElement("textarea"))).toBe(true);

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTextTarget(editable)).toBe(true);
  });

  it("isTextTarget：ProseMirror 编辑区内部节点经 closest 命中容器", () => {
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    const p = document.createElement("p");
    const span = document.createElement("span");
    p.appendChild(span);
    editor.appendChild(p);
    expect(isTextTarget(span)).toBe(true);
    expect(isTextTarget(p)).toBe(true);
  });

  it("isTextTarget：非文本控件不误判（range/select/contenteditable=false）", () => {
    const range = document.createElement("input");
    range.type = "range";
    expect(isTextTarget(range)).toBe(false);

    expect(isTextTarget(document.createElement("select"))).toBe(false);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isTextTarget(checkbox)).toBe(false);

    const locked = document.createElement("div");
    locked.setAttribute("contenteditable", "false");
    expect(isTextTarget(locked)).toBe(false);
  });

  it("isTextTarget：非 Element 目标（null / 文本节点）安全返回 false", () => {
    expect(isTextTarget(null)).toBe(false);
    expect(isTextTarget(document.createTextNode("x"))).toBe(false);
  });
});

describe("热点对齐三角尖端（M2-补丁7 需求 2）", () => {
  it("BaCursor 含尖端偏移常量与推导注释（防止后人'看起来不对'改回中心）", () => {
    const tsx = readFileSync(CURSOR_PATH, "utf-8");
    expect(tsx).toContain("-3.15");
    expect(tsx).toContain("-2.25");
    expect(tsx).toContain("TRI_TIP_OFFSET");
    // 旧的中心对齐写法不得回归
    expect(tsx).not.toContain("translate(-50%, -50%)");
  });

  it("globals.css 按下收缩以尖端为锚（transform-origin 与偏移推导一致）", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    const m = css.match(/\.ba-cursor-tri\s*\{[^}]*transform-origin:\s*([\d.%\s]+);/);
    expect(m, ".ba-cursor-tri 应含尖端锚 transform-origin").toBeTruthy();
    expect(m![1].trim()).toBe("17.5% 12.5%");
  });
});

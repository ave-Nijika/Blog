/**
 * 自定义光标层级回归（M2-补丁4b，zcode 勘察处方）。
 *
 * 背景：.ba-cursor（蓝三角自定义光标）原 z-index 9999 与 MediaLightbox
 * （z-[9999]，portal 在 body 末尾）同层，按 DOM 序灯箱后绘制盖住三角——
 * 主人观感"光标沉到图片下面"。修复提到 int32 上限，本测试静态断言该值
 * 恒大于灯箱层级，防止未来回归。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe(".ba-cursor 层级回归（M2-补丁4b）", () => {
  it("z-index 高于 MediaLightbox 的 9999（int32 上限）", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/globals.css"),
      "utf-8"
    );
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

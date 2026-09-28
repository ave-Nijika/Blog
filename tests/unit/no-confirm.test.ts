/**
 * 媒体删除路径 window.confirm 清零扫描（M2-补丁3 C4/D4）。
 *
 * 背景：原生 confirm 阻塞主线程（主人实测"整个页面卡住、光标消失、标题
 * 显示 IP 的框框"为浏览器原生对话框行为），媒体相关 UI 已全部改为
 * TwoStepButton 两段式内置确认。本测试读源码静态断言媒体路径不存在任何
 * `window.confirm(` 调用；正则要求紧跟半角左括号，注释里的"不再
 * window.confirm：/——"说明文字不会被误伤。
 *
 * 范围外（评论/文章行/正则规则/访客管理/ComfyUI 画廊）按任务书保持现状，
 * 不在本断言清单内。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 媒体删除相关的全部 UI/行为文件（C4 清零范围） */
const MEDIA_UI_FILES = [
  "components/MediaImage.tsx",
  "components/TwoStepButton.tsx",
  "components/BaLazyImage.tsx",
  "app/admin/posts/PostEditor.tsx",
  "app/admin/media/MediaManager.tsx",
  "lib/editor/node-views.tsx",
  "lib/editor/RichTextEditor.tsx",
  "lib/editor/media-actions.ts",
];

const WINDOW_CONFIRM_CALL_RE = /window\.confirm\s*\(/;

describe("媒体删除路径无 window.confirm（M2-补丁3 C4/D4）", () => {
  for (const relPath of MEDIA_UI_FILES) {
    it(`${relPath} 无 window.confirm 调用`, () => {
      const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
      expect(WINDOW_CONFIRM_CALL_RE.test(source)).toBe(false);
    });
  }
});

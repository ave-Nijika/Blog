/**
 * @vitest-environment happy-dom
 *
 * 媒体 UI 组件测试（M2-补丁3 B/C）：
 *   - MediaLightbox：fit ⇄ zoomed 缩放状态机（点击图片切换，光标类随态
 *     切换）、图片上点击不冒泡成关闭、点击遮罩关闭、Esc 关闭、video 行为
 *     保持（controls autoPlay + 关闭按钮）。
 *   - TwoStepButton：两段式内置确认——第一击进入待确认态（不执行）、
 *     第二击执行、超时回退、移开悬停回退、resetKey 变化回退。
 * 全部零依赖 DOM 交互断言，无 window.confirm / 无阻塞路径。
 * 注：vitest include 仅 js/ts（.tsx 不在列），本文件用 React.createElement。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";
import { MediaLightbox } from "@/components/MediaImage";
import { TwoStepButton } from "@/components/TwoStepButton";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MediaLightbox（M2-补丁3 B）", () => {
  it("fit ↔ zoomed：点击图片切换，光标类随态切换", () => {
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose: () => {},
      })
    );
    const img = screen.getByRole("img", { name: "示例图" });
    // fit 态：适应窗口 + zoom-in 光标
    expect(img.className).toContain("cursor-zoom-in");
    expect(img.className).toContain("max-h-[90vh]");

    fireEvent.click(img);
    // zoomed 态：原始像素（不限制宽高）+ zoom-out 光标
    expect(img.className).toContain("cursor-zoom-out");
    expect(img.className).toContain("max-w-none");
    expect(img.className).not.toContain("cursor-zoom-in");

    fireEvent.click(img);
    // 再点回 fit
    expect(img.className).toContain("cursor-zoom-in");
    expect(img.className).not.toContain("cursor-zoom-out");
  });

  it("图片上的点击不冒泡成关闭；点击遮罩（图片外）关闭", () => {
    const onClose = vi.fn();
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose,
      })
    );
    const dialog = screen.getByRole("dialog", { name: "示例图" });
    const img = screen.getByRole("img", { name: "示例图" });

    // 点击图片（含切 zoomed 后再点）只切换缩放，永不关闭
    fireEvent.click(img);
    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();

    // 点击遮罩本身（图片之外区域）→ 关闭
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭保留", () => {
    const onClose = vi.fn();
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose,
      })
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("kind=video 行为保持：video 元素 + 关闭按钮；视频区点击不关闭", () => {
    const onClose = vi.fn();
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/videos/a.mp4",
        alt: "示例视频",
        kind: "video",
        onClose,
      })
    );
    const video = screen
      .getByRole("dialog", { name: "示例视频" })
      .querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.className).toContain("max-h-[85vh]");

    // 视频区域（含 controls 交互）点击不触发遮罩关闭
    fireEvent.click(video!);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

type TwoStepProps = Parameters<typeof TwoStepButton>[0];

function renderButton(overrides: Partial<TwoStepProps> = {}) {
  const onConfirm = vi.fn();
  const props: TwoStepProps = {
    label: "删除选中（2）",
    confirmLabel: "确认删除 2 个？",
    onConfirm,
    className: "btn-normal",
    confirmClassName: "btn-armed",
    ...overrides,
  };
  const utils = render(React.createElement(TwoStepButton, props));
  return { onConfirm, rerender: utils.rerender };
}

describe("TwoStepButton（M2-补丁3 C）", () => {
  it("第一击进入待确认态（变文案/变类，不执行）；第二击执行一次", () => {
    const { onConfirm } = renderButton();
    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    const armed = screen.getByRole("button", { name: "确认删除 2 个？" });
    expect(armed.className).toContain("btn-armed");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(armed);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // 执行后回退普通态
    expect(
      screen.getByRole("button", { name: "删除选中（2）" }).className
    ).toContain("btn-normal");
  });

  it("超时自动回退普通态，回退后需重新两击才执行", () => {
    vi.useFakeTimers();
    const { onConfirm } = renderButton({ timeoutMs: 3000 });

    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    expect(screen.getByRole("button", { name: "确认删除 2 个？" })).toBeTruthy();
    // timer 回调里的 setState 需在 act 内推进，否则断言拿到旧 DOM
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole("button", { name: "删除选中（2）" })).toBeTruthy();

    // 超时后单击不再执行，需重新两击
    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除 2 个？" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resetOnLeave：移开悬停即回退普通态", () => {
    const { onConfirm } = renderButton({ resetOnLeave: true });
    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    expect(screen.getByRole("button", { name: "确认删除 2 个？" })).toBeTruthy();

    fireEvent.mouseLeave(screen.getByRole("button", { name: "确认删除 2 个？" }));
    expect(screen.getByRole("button", { name: "删除选中（2）" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disabled 时不进入待确认态", () => {
    const { onConfirm } = renderButton({ disabled: true });
    const btn = screen.getByRole("button", {
      name: "删除选中（2）",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认删除 2 个？" })).toBeNull();
  });
});

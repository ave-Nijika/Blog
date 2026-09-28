/**
 * @vitest-environment happy-dom
 *
 * 媒体 UI 组件测试（M2-补丁3 B/C + M2-补丁5 A/C1）：
 *   - MediaLightbox：blur-up 秒开状态机——打开即渲染已缓存缩略图（blur）、
 *     原图 blob 就绪后淡入替换、失败保留模糊态、关闭/卸载即 abort 原图
 *     fetch（C1 可观测断言）；缩放状态机保持移除（M2-补丁4 主人裁决）、
 *     遮罩点击关闭、Esc 关闭、video 行为保持。
 *   - TwoStepButton：两段式内置确认——第一击进入待确认态（不执行）、
 *     第二击执行、超时回退、移开悬停回退。
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- blur-up 测试基建：fetch / objectURL 桩 ----

type FakeResponse = { ok: boolean; blob?: () => Promise<Blob>; status?: number };

interface FetchCtl {
  resolve: (r: FakeResponse) => void;
  reject: (e: Error) => void;
  signal: AbortSignal | null;
  calls: number;
}

function stubFetch(): FetchCtl {
  const ctl: FetchCtl = { resolve: () => {}, reject: () => {}, signal: null, calls: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, opts?: { signal?: AbortSignal }) => {
      ctl.calls += 1;
      ctl.signal = opts?.signal ?? null;
      return new Promise<FakeResponse>((resolve, reject) => {
        ctl.resolve = resolve;
        ctl.reject = reject;
      });
    })
  );
  return ctl;
}

/** flush fetch mock 的 microtask 链（resolve → blob() → setOrigUrl） */
async function flushFetch() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fakeJpeg(): Blob {
  return new Blob([new ArrayBuffer(64)], { type: "image/jpeg" });
}

beforeEach(() => {
  // happy-dom 无 createObjectURL 实现——灯箱 objectURL 管线按契约桩化
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:mock-original"),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

describe("MediaLightbox blur-up（M2-补丁5 A/C1）", () => {
  it("打开瞬间即渲染缩略图模糊层（已缓存零等待），原图未就绪时不渲染原图", () => {
    stubFetch(); // fetch 保持 pending：模拟 3-5s 原图下载
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose: () => {},
      })
    );
    const thumb = screen.getByTestId("lightbox-thumb");
    expect(thumb.getAttribute("src")).toBe("/uploads/images/thumb/a.w1600.webp");
    expect(thumb.className).toContain("blur-[8px]");
    expect(screen.queryByTestId("lightbox-original")).toBeNull();
  });

  it("原图 blob 就绪并 onload 后淡入替换，淡入完成移除模糊层", async () => {
    vi.useFakeTimers();
    const ctl = stubFetch();
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose: () => {},
      })
    );
    await act(async () => {
      ctl.resolve({ ok: true, blob: async () => fakeJpeg() });
      await flushFetch();
    });
    // 原图层出现（thumb 阶段 opacity-0，尚未 onload）
    const orig = screen.getByTestId("lightbox-original");
    expect(orig.getAttribute("src")).toBe("blob:mock-original");
    expect(orig.className).toContain("opacity-0");

    fireEvent.load(orig);
    // cross：原图淡入（opacity-100），缩略图模糊层被逐渐覆盖
    expect(orig.className).toContain("opacity-100");
    expect(screen.getByTestId("lightbox-thumb").className).not.toContain("invisible");

    act(() => {
      vi.advanceTimersByTime(340);
    });
    // done：模糊层移除（visibility 隐藏，元素保留撑位防布局跳动）
    expect(screen.getByTestId("lightbox-thumb").className).toContain("invisible");
    expect(orig.className).toContain("opacity-100");
  });

  it("C1：灯箱关闭（卸载）时原图 fetch 被 abort（可观测断言）", () => {
    const ctl = stubFetch(); // pending
    const { unmount } = render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose: () => {},
      })
    );
    expect(ctl.signal).toBeTruthy();
    expect(ctl.signal!.aborted).toBe(false);
    unmount();
    expect(ctl.signal!.aborted).toBe(true);
  });

  it("原图加载失败：保留缩略图模糊态不白屏 + 控制台 warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctl = stubFetch();
    render(
      React.createElement(MediaLightbox, {
        src: "/uploads/images/a.png",
        alt: "示例图",
        onClose: () => {},
      })
    );
    await act(async () => {
      ctl.reject(new Error("HTTP 500"));
      await flushFetch();
    });
    expect(screen.getByTestId("lightbox-thumb")).toBeTruthy();
    expect(screen.queryByTestId("lightbox-original")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("无缩略图可用（外链）→ direct 原图直出，不发起 fetch", () => {
    const ctl = stubFetch();
    render(
      React.createElement(MediaLightbox, {
        src: "https://example.com/a.png",
        alt: "外链图",
        onClose: () => {},
      })
    );
    expect(screen.queryByTestId("lightbox-thumb")).toBeNull();
    expect(ctl.calls).toBe(0);
    const orig = screen.getByTestId("lightbox-original");
    expect(orig.getAttribute("src")).toBe("https://example.com/a.png");
  });
});

describe("MediaLightbox 交互（M2-补丁3 B，M2-补丁5 适配）", () => {
  function renderDirectImage(onClose: () => void) {
    // 外链走 direct 原图直出：聚焦交互语义（与 blur-up 无关）
    stubFetch();
    return render(
      React.createElement(MediaLightbox, {
        src: "https://example.com/a.png",
        alt: "示例图",
        onClose,
      })
    );
  }

  it("M2-补丁4：缩放状态机保持移除——点击图片无行为、无 zoom 光标、不关闭", () => {
    const onClose = vi.fn();
    renderDirectImage(onClose);
    const img = screen.getByRole("img", { name: "示例图" });
    expect(img.className).toContain("max-h-[90vh]");
    expect(img.className).not.toContain("cursor-zoom-in");
    expect(img.className).not.toContain("cursor-zoom-out");
    fireEvent.click(img);
    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("图片上的点击不冒泡成关闭；点击遮罩（图片外）关闭", () => {
    const onClose = vi.fn();
    renderDirectImage(onClose);
    const dialog = screen.getByRole("dialog", { name: "示例图" });
    fireEvent.click(screen.getByRole("img", { name: "示例图" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭保留", () => {
    const onClose = vi.fn();
    renderDirectImage(onClose);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("kind=video 行为保持：video 元素 + 关闭按钮；视频区点击不关闭", () => {
    const onClose = vi.fn();
    stubFetch();
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
    // 视频分支无 blur-up：不渲染缩略图层
    expect(screen.queryByTestId("lightbox-thumb")).toBeNull();

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

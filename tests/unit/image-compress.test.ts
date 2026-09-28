/**
 * @vitest-environment happy-dom
 *
 * 上传端压缩测试（M2-补丁5 B/D2）+ 防并发回退断言（C2）。
 *
 * compressImageFile 依赖浏览器原生 createImageBitmap/canvas，happy-dom 无真实
 * 解码与像素管线——按契约 mock 浏览器 API，断言流程分支与参数（跳过规则、
 * 2560 缩放、jpeg 0.85、透明检测、失败降级、体积保护）。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compressImageFile,
  compressedOutputName,
  shouldCompressFile,
  COMPRESS_MAX_EDGE,
  COMPRESS_QUALITY,
  COMPRESS_MIN_BYTES,
} from "@/lib/image-compress";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** > 800KB 的测试文件（越过 COMPRESS_MIN_BYTES 门槛） */
function bigFile(name: string, type: string, bytes = COMPRESS_MIN_BYTES + 1024): File {
  return new File([new ArrayBuffer(bytes)], name, { type });
}

function stubBitmap(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  return bitmap;
}

function stubCanvas(opts: { opaque: boolean; blob: Blob | null; blobSize?: number }) {
  const drawImage = vi.fn();
  const getImageData = vi.fn(() => {
    // 4 像素的 imageData：全部不透明（alpha=255）或首像素透明
    const data = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    if (!opts.opaque) data[3] = 128;
    return { data, width: 4, height: 4 };
  });
  const ctx = { drawImage, getImageData };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  let captured: { type: string | undefined; quality: number | undefined } | null = null;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (cb: BlobCallback, type?: string, quality?: number) => {
      captured = { type, quality };
      cb(opts.blob);
    }
  );
  return { drawImage, toBlobArgs: () => captured! };
}

function fakeJpegBlob(bytes = 100 * 1024): Blob {
  return new Blob([new ArrayBuffer(bytes)], { type: "image/jpeg" });
}

describe("压缩资格判定（shouldCompressFile，M2-补丁5 B1）", () => {
  it("GIF / ≤800KB / 非图片类型不参与压缩", () => {
    expect(shouldCompressFile({ type: "image/gif", size: 10 * 1024 * 1024 })).toBe(false);
    expect(shouldCompressFile({ type: "image/jpeg", size: COMPRESS_MIN_BYTES })).toBe(false);
    expect(shouldCompressFile({ type: "image/jpeg", size: COMPRESS_MIN_BYTES - 1 })).toBe(false);
    expect(shouldCompressFile({ type: "video/mp4", size: 10 * 1024 * 1024 })).toBe(false);
    expect(shouldCompressFile({ type: "application/json", size: 10 * 1024 * 1024 })).toBe(false);
    // jpeg 与 png（透明检测在绘制后）参与压缩
    expect(shouldCompressFile({ type: "image/jpeg", size: COMPRESS_MIN_BYTES + 1 })).toBe(true);
    expect(shouldCompressFile({ type: "image/png", size: COMPRESS_MIN_BYTES + 1 })).toBe(true);
  });
});

describe("compressImageFile（M2-补丁5 D2）", () => {
  it("GIF / 小文件 / 非图片直接原样返回（不触碰解码 API）", async () => {
    const spy = vi.fn();
    vi.stubGlobal("createImageBitmap", spy);
    const gif = bigFile("anim.gif", "image/gif");
    const small = new File([new ArrayBuffer(10)], "small.jpg", { type: "image/jpeg" });
    const video = bigFile("clip.mp4", "video/mp4");
    expect(await compressImageFile(gif)).toBe(gif);
    expect(await compressImageFile(small)).toBe(small);
    expect(await compressImageFile(video)).toBe(video);
    expect(spy).not.toHaveBeenCalled();
  });

  it("大图：最长边缩到 2560，toBlob(image/jpeg, 0.85)，png 扩展名调整", async () => {
    stubBitmap(4000, 3000);
    const { drawImage, toBlobArgs } = stubCanvas({ opaque: true, blob: fakeJpegBlob() });
    const png = bigFile("photo.png", "image/png");
    const out = await compressImageFile(png);
    expect(out).not.toBe(png);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("photo.jpg"); // B3：basename 不变，png→jpg
    expect(out.size).toBe(100 * 1024);
    // 4000x3000 → 2560x1920（最长边 2560，等比）。drawImage(bitmap, 0, 0, w, h)
    expect(drawImage).toHaveBeenCalledTimes(1);
    const args = drawImage.mock.calls[0];
    expect(args[3]).toBe(COMPRESS_MAX_EDGE);
    expect(args[4]).toBe(1920);
    expect(toBlobArgs().type).toBe("image/jpeg");
    expect(toBlobArgs().quality).toBe(COMPRESS_QUALITY);
  });

  it("已是 jpeg：扩展名保持 jpg 不变", async () => {
    stubBitmap(3000, 2000);
    stubCanvas({ opaque: true, blob: fakeJpegBlob() });
    const jpg = bigFile("shot.jpeg", "image/jpeg");
    const out = await compressImageFile(jpg);
    expect(out.name).toBe("shot.jpeg");
    expect(out.type).toBe("image/jpeg");
  });

  it("透明 PNG 不压缩（转 jpeg 会丢透明），原样返回", async () => {
    stubBitmap(2000, 1500);
    stubCanvas({ opaque: false, blob: fakeJpegBlob() });
    const png = bigFile("sticker.png", "image/png");
    expect(await compressImageFile(png)).toBe(png);
  });

  it("压缩结果反而更大时保留原文件（避免重编码代际损失）", async () => {
    stubBitmap(2000, 1500);
    const huge = fakeJpegBlob(COMPRESS_MIN_BYTES * 2);
    stubCanvas({ opaque: true, blob: huge });
    const jpg = bigFile("already-good.jpg", "image/jpeg");
    expect(await compressImageFile(jpg)).toBe(jpg);
  });

  it("toBlob 失败（null）→ 原样返回", async () => {
    stubBitmap(2000, 1500);
    stubCanvas({ opaque: true, blob: null });
    const jpg = bigFile("x.jpg", "image/jpeg");
    expect(await compressImageFile(jpg)).toBe(jpg);
  });

  it("解码失败（B4 降级）→ 原样返回，行为与现状一致", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("corrupt image");
    }));
    const file = bigFile("broken.png", "image/png");
    expect(await compressImageFile(file)).toBe(file);
  });
});

describe("compressedOutputName（B3：客户端名仅作 alt 提示，服务端名仍由 API 生成）", () => {
  it("png → jpg；其他扩展名不变", () => {
    expect(compressedOutputName("a.png")).toBe("a.jpg");
    expect(compressedOutputName("b.PNG")).toBe("b.jpg");
    expect(compressedOutputName("c.jpeg")).toBe("c.jpeg");
    expect(compressedOutputName("d.webp")).toBe("d.webp");
  });
});

describe("BaLazyImage 防并发回退断言（M2-补丁5 C2）", () => {
  it("并发限流保持 MAX_CONCURRENT=2（comfyui 复发防线）", () => {
    const src = readFileSync(resolve(process.cwd(), "components/BaLazyImage.tsx"), "utf-8");
    expect(src).toMatch(/MAX_CONCURRENT\s*=\s*2/);
  });

  it("视口懒加载（IntersectionObserver）与并发队列保留", () => {
    const src = readFileSync(resolve(process.cwd(), "components/BaLazyImage.tsx"), "utf-8");
    expect(src).toContain("IntersectionObserver");
    expect(src).toContain("acquire(");
  });
});

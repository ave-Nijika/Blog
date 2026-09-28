"use client";

/**
 * 上传端浏览器图片压缩（M2-补丁5 B1）：选图/粘贴/拖拽上传**图片**时，在上传前
 * 用浏览器原生 canvas 压缩——最长边 2560px、image/jpeg 质量 0.85。3.8MB 手机
 * 原图 → 约 500-800KB，灯箱原图加载从带宽受限的数秒降到 ~1s（服务端零改动，
 * 压缩纯客户端）。
 *
 * 跳过规则（原样上传）：
 *   - 非 image/* 与白名单外的类型；
 *   - GIF 动图（canvas 重编码会丢动画帧）；
 *   - 已 ≤ 800KB 的文件（重编码收益小）；
 *   - 带透明通道的 PNG（转 jpeg 丢透明——绘制后逐像素扫描 alpha 判定）；
 *   - createImageBitmap 解码失败 / canvas 不可用 / toBlob 失败（B4 降级：
 *     行为与不压缩的现状完全一致）；
 *   - 压缩结果反而比原文件大（已是高压缩小图时避免代际损失）。
 *
 * 文件名语义（B3）：basename 不变，仅 png→jpg 按压缩结果调整扩展名；
 * 该名字只用于 alt 提示——服务端文件名仍由上传 API 生成（安全语义零变化）。
 */

/** 最长边上限（px） */
export const COMPRESS_MAX_EDGE = 2560;
/** jpeg 编码质量 */
export const COMPRESS_QUALITY = 0.85;
/** 小于该字节数的文件跳过压缩 */
export const COMPRESS_MIN_BYTES = 800 * 1024;

/** 参与压缩的图片类型：jpeg 直压；png 绘制后先做透明检测（有透明则跳过） */
const COMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png"]);

/** 压缩后输出文件名：basename 保留，png 扩展名按 jpeg 结果改为 jpg */
export function compressedOutputName(name: string): string {
  return name.replace(/\.png$/i, ".jpg");
}

/** 压缩资格判定（同步纯函数，可单测）：GIF/小图/非白名单类型不压 */
export function shouldCompressFile(file: { type: string; size: number }): boolean {
  if (file.size <= COMPRESS_MIN_BYTES) return false;
  return COMPRESSIBLE_TYPES.has(file.type);
}

/**
 * 压缩单张图片文件。任何一步失败都原样返回入参（B4：调用方无需感知降级，
 * 行为与未引入压缩时一致）。
 */
export async function compressImageFile(file: File): Promise<File> {
  try {
    if (!shouldCompressFile(file)) return file;
    if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
      return file; // 非浏览器环境（SSR/测试桩缺失）不压
    }
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(
        1,
        COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
      );
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);
      // 透明检测（png 转 jpeg 会丢透明）：绘制后逐像素扫 alpha，任一
      // 非不透明像素即放弃压缩，保留原 png
      if (file.type === "image/png") {
        const { data } = ctx.getImageData(0, 0, width, height);
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 255) return file;
        }
      }
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", COMPRESS_QUALITY);
      });
      if (!blob) return file;
      if (blob.size >= file.size) return file; // 重编码无收益，保留原图
      return new File([blob], compressedOutputName(file.name), {
        type: "image/jpeg",
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return file; // 解码失败/极端格式 → 原样上传（B4）
  }
}

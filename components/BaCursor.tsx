"use client";

import { useEffect, useRef } from "react";

/**
 * 官网同款"蓝色三角"自定义光标（桌面指针设备启用）。
 * - 仅在 (pointer: fine) 且未开启 prefers-reduced-motion 时接管；
 * - rAF + lerp 缓动跟随，按下时收缩；
 * - hover 文本输入类元素时切换为"文本选择"形态（蓝 I-beam，M2-补丁7），
 *   原生 I-beam 已由 globals.css 移除例外一并隐藏（输入时闪烁的 caret 是
 *   文本插入符、绘制层，与本光标无关，不受影响）。
 */

/**
 * 文本形态判定目标：文本类 input + textarea + contenteditable
 * （ProseMirror 编辑区即 [contenteditable="true"]，无需特判）。
 * select 不在内——它是可点击控件而非文本编辑，伪光标保持三角形态；
 * 其展开的下拉列表是 OS 层控件，任何页面光标方案都覆盖不到（现状同）。
 * 非文本 input（checkbox/radio/range/file 等）不在白名单，保持三角。
 */
const TEXT_TARGET_SELECTOR = [
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="email"]',
  'input[type="password"]',
  'input[type="number"]',
  "input:not([type])",
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(",");

/** hover 目标是否呈现文本形态（closest 向上找：编辑区内部节点命中容器） */
export function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_TARGET_SELECTOR) !== null;
}

/**
 * 三角热点偏移（M2-补丁7 需求 2）：transform 让尖端而非几何中心落在鼠标
 * 真实坐标。推导：SVG viewBox 20×20 渲染 18×18（scale 0.9），尖端 path
 * (3.5, 2.5) → 元素内 (3.15, 2.25)px，故 translate 取其负值。
 * I-beam 形态竖干在元素正中（x=10），沿用中心对齐 (-9, -9)。
 */
const TRI_TIP_OFFSET = { x: -3.15, y: -2.25 };
const CENTER_OFFSET = { x: -9, y: -9 };

export function BaCursor() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) return;

    document.documentElement.classList.add("ba-cursor-active");

    let tx = window.innerWidth / 2;
    let ty = window.innerHeight / 2;
    let x = tx;
    let y = ty;
    let raf = 0;
    let shown = false;
    let textMode = false; // 当前是否文本形态（target 去重缓存，避免每帧 closest）
    let hoverTarget: EventTarget | null = null;
    let pressing = false; // 按下期间锁定形态：拖选文本/拖滑块时鼠标会移出元素，不闪变

    const applyOffset = () => {
      const off = textMode ? CENTER_OFFSET : TRI_TIP_OFFSET;
      el.style.transform = `translate3d(${x + off.x}px, ${y + off.y}px, 0)`;
    };

    const onMove = (e: MouseEvent) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!pressing && e.target !== hoverTarget) {
        hoverTarget = e.target;
        const next = isTextTarget(e.target);
        if (next !== textMode) {
          textMode = next;
          el.classList.toggle("is-text", textMode);
        }
      }
      if (!shown) {
        shown = true;
        x = tx;
        y = ty;
        el.style.opacity = "1";
      }
    };
    const onDown = () => {
      pressing = true;
      el.classList.add("is-down");
    };
    const onUp = () => {
      pressing = false;
      el.classList.remove("is-down");
    };
    const onLeave = () => {
      shown = false;
      hoverTarget = null; // 回到页面后强制重判形态
      el.style.opacity = "0";
    };
    const tick = () => {
      x += (tx - x) * 0.3;
      y += (ty - y) * 0.3;
      applyOffset();
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    document.documentElement.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(tick);

    return () => {
      document.documentElement.classList.remove("ba-cursor-active");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="ba-cursor" aria-hidden style={{ opacity: 0 }}>
      {/* 三角形态（默认）：热点经 TRI_TIP_OFFSET 对齐左上尖端 */}
      <svg className="ba-cursor-tri" viewBox="0 0 20 20" width="18" height="18" role="presentation">
        <path
          d="M3.5 2.5 L17 10 L3.5 17.5 Z"
          fill="rgb(18 137 249)"
          stroke="white"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      {/* 文本形态（.is-text 淡入）：蓝 I-beam，白色外描与三角同风格 */}
      <svg className="ba-cursor-beam" viewBox="0 0 20 20" width="18" height="18" role="presentation">
        <path
          d="M5.2 3.2 H14.8 M5.2 16.8 H14.8 M10 3.2 V16.8"
          fill="none"
          stroke="white"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M5.2 3.2 H14.8 M5.2 16.8 H14.8 M10 3.2 V16.8"
          fill="none"
          stroke="rgb(18 137 249)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

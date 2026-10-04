"use client";

import { useEffect } from "react";

/**
 * 点击反馈（M2-补丁8 A4）：按下时在点击位置播放一次"三角收缩淡出"。
 * 旧 DOM 伪光标的 is-down 收缩随方案切换（CSS 自定义指针）一并移除，
 * 主人要求保留该观感但不得恢复跟随循环——本特效是一次性节点：
 * mousedown 时在 (clientX, clientY) 插入，WAAPI 动画结束即销毁，
 * 零 rAF 跟随（指针本身已由 CSS cursor 零延迟跟手，这里只做瞬时反馈）。
 * - 仅精细指针设备启用；prefers-reduced-motion 尊重动效偏好直接关闭
 * - 三角图形与全局 CSS 指针同源（尖端 (3.5,2.5) → (3.15,2.25)px），
 *   transform-origin 对齐尖端，收缩时尖端不动、身体向尖端收拢
 * - z-index 与 ClickFX 特效层同体系（圆环在外扩散、三角在内收缩，
 *   三角层低于 ClickFX canvas 不遮挡圆环），高于灯箱（9999）
 * - 连点各自独立成节点，动画结束/兜底计时器双保险移除，无 DOM 泄漏
 */
export function ClickPulse() {
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const TRI_HTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="18" height="18" role="presentation"><path d="M3.5 2.5 L17 10 L3.5 17.5 Z" fill="rgb(18,137,249)" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';

    const onDown = (e: MouseEvent) => {
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "position:fixed;top:0;left:0;z-index:2147483645;pointer-events:none;width:18px;height:18px;will-change:transform,opacity;" +
        `transform:translate3d(${e.clientX - 3.15}px, ${e.clientY - 2.25}px, 0);`;
      el.innerHTML = TRI_HTML; // 静态常量，无用户输入
      document.body.appendChild(el);
      const svg = el.firstChild;
      if (svg instanceof SVGElement) {
        svg.style.transformOrigin = "3.15px 2.25px";
        const anim = svg.animate(
          [
            { transform: "scale(1)", opacity: "1" },
            { transform: "scale(0.82)", opacity: "0" },
          ],
          { duration: 160, easing: "ease-out", fill: "forwards" },
        );
        anim.finished.then(() => el.remove()).catch(() => el.remove());
      } else {
        el.remove();
      }
      window.setTimeout(() => el.remove(), 600); // 后台标签页等动画不跑时兜底（幂等）
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  return null;
}

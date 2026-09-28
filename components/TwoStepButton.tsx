"use client";

/**
 * 两段式危险操作按钮（M2-补丁3 C）：第一次点击进入"待确认"态（变文案/
 * 变样式，不弹窗、不阻塞主线程），timeoutMs 内再次点击才执行 onConfirm；
 * 超时自动回退普通态。取代 window.confirm——原生对话框阻塞主线程且渲染
 * 受浏览器接管（主人看到的"整个页面卡住 + 光标消失 + 标题带 IP 的框"即其
 * 浏览器行为），内置确认无这些问题。
 *
 * 使用方：编辑器悬停动作条（移除并删除文件，resetOnLeave——移开悬停即回退）、
 * BubbleMenu 彻底删除、媒体面板彻底删除、媒体管理页批量删除（调用方以
 * key={选中数} 重挂载本组件实现"选中数变化即回退"，React 惯用法，见
 * you-might-not-need-an-effect——组件内不做 effect 同步 setState）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function TwoStepButton({
  label,
  confirmLabel,
  onConfirm,
  className,
  confirmClassName,
  timeoutMs = 3000,
  resetOnLeave = false,
  disabled = false,
  title,
  confirmTitle,
  ariaLabel,
  confirmAriaLabel,
}: {
  /** 常态文案 */
  label: ReactNode;
  /** 待确认态文案（第一击后显示） */
  confirmLabel: ReactNode;
  /** 第二击执行的回调 */
  onConfirm: () => void;
  /** 常态 className（完整类串，两态不叠加） */
  className?: string;
  /** 待确认态 className（完整类串） */
  confirmClassName?: string;
  /** 待确认态保持时长，超时回退普通态 */
  timeoutMs?: number;
  /** 鼠标移开按钮即回退（悬停动作条场景用；面板/批量按钮靠超时回退） */
  resetOnLeave?: boolean;
  disabled?: boolean;
  title?: string;
  confirmTitle?: string;
  ariaLabel?: string;
  confirmAriaLabel?: string;
}) {
  const [arming, setArming] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const disarm = useCallback(() => {
    clearTimer();
    setArming(false);
  }, [clearTimer]);

  // 卸载清理定时器（无 setState，纯外部系统清理）
  useEffect(() => () => clearTimer(), [clearTimer]);

  const handleClick = () => {
    if (disabled) return;
    if (!arming) {
      setArming(true);
      clearTimer();
      timerRef.current = window.setTimeout(disarm, timeoutMs);
      return;
    }
    disarm();
    onConfirm();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseLeave={resetOnLeave && arming ? disarm : undefined}
      disabled={disabled}
      title={arming ? (confirmTitle ?? title) : title}
      aria-label={arming ? (confirmAriaLabel ?? ariaLabel) : ariaLabel}
      className={arming ? confirmClassName : className}
    >
      {arming ? confirmLabel : label}
    </button>
  );
}

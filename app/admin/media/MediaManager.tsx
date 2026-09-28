"use client";

/**
 * 媒体管理客户端组件（M1-补丁2 C）：
 *   - 「扫描孤儿」→ GET /api/admin/media/orphans（总文件数/总占用 + 零引用清单）
 *   - 全选/单选 → 「删除选中」→ POST /api/admin/media/orphans/purge
 *     （后端对每个 url 独立重查引用，已被引用的文件 skipped 并逐条提示原因）
 * 仅渲染后端返回的 images/videos 路径（C4，comfy 永不出现在本页）。
 */
import { useState } from "react";
import { fetchWithCsrf } from "@/lib/fetchWithCsrf";
import { TwoStepButton } from "@/components/TwoStepButton";

type MediaKind = "image" | "video";

interface Orphan {
  url: string;
  kind: MediaKind;
  sizeBytes: number;
  mtime: string;
}

interface OrphansResponse {
  ok?: boolean;
  totalFiles?: number;
  totalBytes?: number;
  orphans?: Orphan[];
  error?: string;
}

interface PurgeResponse {
  ok?: boolean;
  deleted?: string[];
  skipped?: { url: string; referencedBy: number }[];
  error?: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fileNameOf(url: string): string {
  return url.split("/").pop() || url;
}

export function MediaManager() {
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<{ totalFiles: number; totalBytes: number } | null>(null);
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ url: string; referencedBy: number }[]>([]);
  const [scanned, setScanned] = useState(false);

  async function scan() {
    setError(null);
    setMessage(null);
    setSkipped([]);
    setScanning(true);
    try {
      const res = await fetchWithCsrf("/api/admin/media/orphans");
      const data = (await res.json().catch(() => ({}))) as OrphansResponse;
      if (!res.ok || !data.ok) {
        setError(data.error || `扫描失败（HTTP ${res.status}）`);
        return;
      }
      setSummary({
        totalFiles: data.totalFiles ?? 0,
        totalBytes: data.totalBytes ?? 0,
      });
      setOrphans(data.orphans ?? []);
      setSelected(new Set());
      setScanned(true);
    } catch {
      setError("网络异常，请重试");
    } finally {
      setScanning(false);
    }
  }

  function toggle(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  const allSelected = orphans.length > 0 && selected.size === orphans.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.url)));
  }

  /** M2-补丁3 C3：确认改由按钮层两段式内置完成（不再 window.confirm），只负责执行 */
  async function purgeSelected() {
    const urls = [...selected];
    if (urls.length === 0 || purging) return;
    setError(null);
    setMessage(null);
    setSkipped([]);
    setPurging(true);
    try {
      const res = await fetchWithCsrf("/api/admin/media/orphans/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = (await res.json().catch(() => ({}))) as PurgeResponse;
      if (!res.ok || !data.ok) {
        setError(data.error || `删除失败（HTTP ${res.status}）`);
        return;
      }
      const deleted = data.deleted ?? [];
      const skippedList = data.skipped ?? [];
      // C3：删除项从清单移除；skipped 保留在清单中（文件仍在磁盘）并逐条提示原因
      setOrphans((prev) => prev.filter((o) => !deleted.includes(o.url)));
      setSelected(new Set());
      setSkipped(skippedList);
      setMessage(
        deleted.length > 0
          ? `已删除 ${deleted.length} 个文件${skippedList.length > 0 ? `，跳过 ${skippedList.length} 个仍被引用的文件` : ""}。`
          : "没有文件被删除（选中的文件都已重新被文章引用）。"
      );
      if (summary) {
        setSummary((prev) =>
          prev
            ? {
                ...prev,
                totalFiles: Math.max(0, prev.totalFiles - deleted.length),
                totalBytes: Math.max(
                  0,
                  prev.totalBytes -
                    orphans
                      .filter((o) => deleted.includes(o.url))
                      .reduce((sum, o) => sum + o.sizeBytes, 0)
                ),
              }
            : prev
        );
      }
    } catch {
      setError("网络异常，请重试");
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="ba-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm text-slate-600 dark:text-slate-300">
          {summary ? (
            <>
              图片/视频共 <span className="ba-font-round text-lg text-[rgb(var(--ba-primary))]">{summary.totalFiles}</span> 个，
              占用 <span className="ba-font-round text-lg text-[rgb(var(--ba-primary))]">{humanSize(summary.totalBytes)}</span>
              <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">（含仍被引用的文件）</span>
            </>
          ) : (
            <span className="text-slate-400 dark:text-slate-500">尚未扫描，点击右侧按钮获取占用与孤儿清单</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          className="ba-button-primary px-4 py-2 text-sm disabled:opacity-60"
        >
          {scanning ? "扫描中…" : "扫描孤儿"}
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {message}
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">以下文件在删除前被复查出仍有引用，已保留：</p>
          <ul className="mt-1 list-disc pl-5">
            {skipped.map((s) => (
              <li key={s.url}>
                「{fileNameOf(s.url)}」仍被 {s.referencedBy} 处文章内容引用
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {scanned ? (
        orphans.length === 0 ? (
          <div className="ba-card p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            没有孤儿文件，磁盘很干净 ✨
          </div>
        ) : (
          <div className="ba-card p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="全选孤儿文件"
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:text-sky-400 dark:focus:ring-sky-400"
                />
                全选（{orphans.length} 个孤儿）
              </label>
              {/* M2-补丁3 C3：两段式内置确认——第一击变"确认删除 N 个？"，
                  再击执行；key=选中数使选中集变化即重挂载回退普通态（避免
                  "确认删除 3 个？"实际删 4 个的漂移）；已被引用的文件后端
                  会 skipped，不会误删 */}
              <TwoStepButton
                key={selected.size}
                label={purging ? "删除中…" : `删除选中（${selected.size}）`}
                confirmLabel={purging ? "删除中…" : `确认删除 ${selected.size} 个？`}
                onConfirm={() => void purgeSelected()}
                disabled={selected.size === 0 || purging}
                title="从服务器永久删除选中文件（已被文章重新引用的会自动跳过）"
                confirmTitle="再次点击确认从服务器永久删除"
                className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-700 disabled:opacity-50"
                confirmClassName="rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white shadow-sm ring-2 ring-rose-400 disabled:opacity-50"
              />
            </div>
            <ul className="flex flex-col">
              {orphans.map((o) => (
                <li
                  key={o.url}
                  className="flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.url)}
                    onChange={() => toggle(o.url)}
                    aria-label={`选择 ${fileNameOf(o.url)}`}
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:text-sky-400 dark:focus:ring-sky-400"
                  />
                  {o.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={o.url}
                      alt=""
                      loading="lazy"
                      className="h-10 w-16 shrink-0 rounded border border-slate-200 object-cover dark:border-slate-700"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="flex h-10 w-16 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50 text-lg dark:border-slate-700 dark:bg-slate-800"
                    >
                      🎬
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-700 dark:text-slate-200">
                      {fileNameOf(o.url)}
                    </span>
                    <span className="block truncate text-xs text-slate-400 dark:text-slate-500">
                      {o.url}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
                    <span className="block">{humanSize(o.sizeBytes)}</span>
                    <span className="block">{formatDate(o.mtime)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </div>
  );
}

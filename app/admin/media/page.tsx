/**
 * /admin/media — 媒体管理：uploads 图片/视频的孤儿巡检与彻底删除（M1-补丁2 C）。
 *
 * 服务端组件：requireAdmin 守卫；清单获取/选择/批量清理由 MediaManager
 * 客户端组件走 /api/admin/media*。
 *
 * comfy 隔离（红线）：本页与后端 API 只覆盖 /uploads/{images|videos}/，
 * ComfyUI 工作流文件（/uploads/comfy/**）不在巡检与删除范围内。
 */
import { requireAdmin } from "@/lib/auth";
import { LogoutButton } from "../LogoutButton";
import { MediaManager } from "./MediaManager";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "媒体管理",
  robots: { index: false, follow: false },
};

export default async function MediaPage() {
  await requireAdmin();

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <a href="/admin" className="hover:text-sky-600 dark:hover:text-sky-300">
              ← 后台首页
            </a>
            <span>/</span>
            <span>媒体管理</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            媒体管理
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            文章图片/视频（uploads/images、uploads/videos）的占用总览与孤儿清理：
            已不被任何文章引用的文件可在此彻底删除。仅删除前会实时复查引用，
            仍被引用的文件会被拒绝。ComfyUI 工作流文件不在此范围。
          </p>
        </div>
        <LogoutButton />
      </header>

      <MediaManager />
    </div>
  );
}

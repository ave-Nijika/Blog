/**
 * 备案信息区块（服务端组件）。
 *
 * 为什么是 server component（M4.2 根因修复）：此前备案区块写在 client 组件
 * Footer 里，可见性条件依赖 `process.env.NEXT_PUBLIC_*` 的构建期内联——
 * 部署链路上一旦客户端构建时 env 缺失，内联为空串后被常量折叠 + 死代码
 * 消除整段剔除（chunk 里连 beian.miit.gov.cn 字面量都不存在），而 SSR 读
 * 容器运行时 env（有值）→ 服务端/客户端渲染不一致 → hydration 后备案消失。
 * 改为 server component 后：每次请求在服务端读运行时 env 渲染，经 RSC
 * payload 作为 children 传入 client 组件 Footer，客户端不持有该代码，
 * hydration/重渲染都不影响其可见性。
 *
 * 值由部署环境通过 NEXT_PUBLIC_* 注入，仓库不存储任何备案号；未配置时不渲染。
 * 布局：横排一行（ICP │ 图标 + 公安备案号），窄屏 flex-wrap 自然换行。
 */
export function BeianFooter() {
  const icp = process.env.NEXT_PUBLIC_ICP_NUMBER;
  const gongan = process.env.NEXT_PUBLIC_GONGAN_NUMBER;
  const gonganCode = process.env.NEXT_PUBLIC_GONGAN_CODE;
  if (!icp && !gongan) return null;

  return (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-slate-400 dark:text-slate-500">
      {icp ? (
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-[color:rgb(var(--ba-primary))]"
        >
          {icp}
        </a>
      ) : null}
      {icp && gongan ? (
        <span aria-hidden className="select-none text-slate-300 dark:text-slate-600">
          │
        </span>
      ) : null}
      {gongan ? (
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${gonganCode ?? ""}`}
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-center gap-1.5 transition-colors hover:text-[color:rgb(var(--ba-primary))]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- 公安备案小图标，静态资源无需 next/image 优化 */}
          <img
            src="/gongan-beian.png"
            alt="公安联网备案图标"
            width={18}
            height={20}
            className="h-4 w-auto"
          />
          {gongan}
        </a>
      ) : null}
    </div>
  );
}

/**
 * 共享 markdown 渲染配置（M1-补丁1 C1/C3）。
 *
 * 编辑页预览（PostEditor）与文章详情页（app/posts/[slug]/page.tsx）必须共用
 * 同一份 components 映射——历史上"预览与详情页行为不一致"靠人工同步，本模块
 * 从结构上消灭该事故模式：一次修改两处生效。
 *
 * 用法：
 *   <ReactMarkdown
 *     remarkPlugins={[remarkGfm]}
 *     rehypePlugins={[rehypeHighlight]}
 *     components={getMarkdownComponents({ enhanceCodeBlock: true })}
 *   >
 *     {renderVideoSyntax(body)}
 *   </ReactMarkdown>
 *
 * 正文须先经 renderVideoSyntax 预处理（@video → 标准图片语法，围栏内不动），
 * 图片/视频由 components.img 按 URL 扩展名分流（VideoBlock / MediaImage）。
 * 代码块增强（CodeBlock）仅在详情页启用（enhanceCodeBlock: true，保持现状语义）。
 */
import type { Components } from "react-markdown";
import { CodeBlock } from "@/components/CodeBlock";
import { MediaImage } from "@/components/MediaImage";
import { VideoBlock } from "@/components/VideoBlock";
import { isVideoUrl } from "@/lib/media";

export function getMarkdownComponents(
  opts: { enhanceCodeBlock?: boolean } = {}
): Components {
  const components: Components = {
    img: ({ src, alt }) => {
      // react-markdown 的 src 理论上可为 Blob（本站内容源只会是字符串）
      const url = typeof src === "string" ? src : "";
      if (isVideoUrl(url)) {
        return <VideoBlock src={url} alt={alt ?? ""} />;
      }
      return <MediaImage src={url} alt={alt ?? ""} />;
    },
  };
  if (opts.enhanceCodeBlock) {
    components.pre = ({ children, className }) => (
      <CodeBlock className={className}>{children}</CodeBlock>
    );
  }
  return components;
}

"use client";

/**
 * 编辑器扩展集合（M2-补丁1 A1）。
 *
 * Tiptap 白名单依赖：@tiptap/react / @tiptap/pm / @tiptap/core / @tiptap/starter-kit /
 * @tiptap/extension-image / prosemirror-markdown（markdown 适配，选型论证见任务报告）。
 * 本文件同时被 RichTextEditor（React）与往返测试（getSchema 头沙盒）引用——
 * schema 只由这一份扩展列表定义，测试与编辑器零漂移。
 *
 * 自定义节点/Mark（全部 @tiptap/core 内置能力，零额外依赖）：
 *   - EditorImage：官方 Image 配置为 inline（正文图片天然位于段落内），
 *     扩展 linkHref/linkTitle（携带"链接图片"信息往返无损）与 uploading/uploadId
 *     （粘贴/拖放上传的占位节点标记，不渲染进 DOM）
 *   - VideoBlock：@video[alt](url) 自定义语法节点（生命线 2），inline 原子、可拖拽
 *   - RawMarkdown：编辑器不建模的块（GFM 表格等）原样保存的兜底节点（生命线 1）
 *   - EditorLink：链接 mark（StarterKit 不含 link，且其不在依赖白名单——自实现 ~20 行）
 */
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { Mark, Node, ReactNodeViewRenderer } from "@tiptap/react";
import {
  EditorImageView,
  EditorRawView,
  EditorVideoView,
} from "./node-views";

export const EDITOR_IMAGE_NODE = "image";
export const EDITOR_VIDEO_NODE = "videoBlock";
export const EDITOR_RAW_NODE = "rawMarkdown";
export const EDITOR_LINK_MARK = "link";

/** 图片节点上"链接携带"attr 名（markdown-it core rule 注入，往返用） */
export const LINK_HREF_ATTR = "linkHref";
export const LINK_TITLE_ATTR = "linkTitle";

export const EditorImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [LINK_HREF_ATTR]: {
        default: null,
        parseHTML: (el) => el.closest("a")?.getAttribute("href") ?? null,
      },
      [LINK_TITLE_ATTR]: { default: null },
      uploading: { default: false, rendered: false },
      uploadId: { default: null, rendered: false },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(EditorImageView);
  },
}).configure({ inline: true });

export const VideoBlock = Node.create({
  name: EDITOR_VIDEO_NODE,
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      alt: { default: null },
      url: {},
      linkHref: { default: null },
      linkTitle: { default: null },
      uploading: { default: false, rendered: false },
      uploadId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: "video[data-video-block]",
        getAttrs: (el) => ({
          url: el.getAttribute("src") ?? "",
          alt: el.getAttribute("alt"),
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "video",
      { ...HTMLAttributes, src: node.attrs.url, "data-video-block": "" },
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EditorVideoView);
  },
});

export const RawMarkdown = Node.create({
  name: EDITOR_RAW_NODE,
  group: "block",
  atom: true,
  defining: true,
  addAttributes() {
    return {
      source: {},
      kind: { default: "raw" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "pre[data-raw-markdown]",
        getAttrs: (el) => ({
          source: el.textContent ?? "",
          kind: el.getAttribute("data-raw-markdown") ?? "raw",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "pre",
      { "data-raw-markdown": node.attrs.kind ?? "raw" },
      ["code", node.attrs.source ?? ""],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EditorRawView);
  },
});

export const EditorLink = Mark.create({
  name: EDITOR_LINK_MARK,
  inclusive: false,
  addAttributes() {
    return {
      href: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "a[href]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "a",
      { ...HTMLAttributes, rel: "noopener noreferrer nofollow", target: "_blank" },
    ];
  },
});

/** 编辑器 schema 的唯一来源：RichTextEditor 与往返测试共用同一列表。 */
export function buildEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    EditorImage,
    VideoBlock,
    RawMarkdown,
    EditorLink,
  ];
}

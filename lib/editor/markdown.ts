/**
 * markdown ⇄ ProseMirror(Tiptap) 适配层（M2-补丁1 生命线 1/2）。
 *
 * 选型：prosemirror-markdown 自适配（任务书 0.节允许，论证见报告）——
 * MarkdownParser（markdown-it tokenizer + tokenHandlers）进，
 * MarkdownSerializerState（mark 分组/转义框架）出；节点/Mark 序列化器
 * 全部显式移植自其 defaultMarkdownSerializer 并按本站语法扩展。
 *
 * 稳定性契约（生命线 1 的验收方式，D2）：serialize(parse(md)) 再 parse
 * 得到与 parse(md) 相同的树（定点稳定），因此"parse→render"与
 * "parse→ser→parse→ser→render"（共享渲染管线）HTML 必然一致。
 * 已知归一化（两侧都经 parse，渲染等价）：
 *   - 软换行 → 空格（prosemirror-markdown 内置行为，与站点 CommonMark 渲染一致）
 *   - 连续空行 → 单空行、列表 marker 统一 "-"、loose 列表 → tight（Tiptap 无
 *     tight 属性；两侧渲染一致）
 *   - 编辑器不建模的块（GFM 表格等）→ rawMarkdown 节点原样保存（字节级保留）
 *   - 文本中的 HTML 字面量（html:false 解析为文本）→ 序列化时转义（E5：不执行、
 *     不以原始 HTML 形态保留）
 */
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { getSchema, type Extensions } from "@tiptap/core";
import type { Mark as PMMark, Node as PMNode, Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import {
  MarkdownParser,
  MarkdownSerializerState,
} from "prosemirror-markdown";
import { computeFencedLineFlags, VIDEO_SYNTAX_RE } from "@/lib/media";
import {
  buildEditorExtensions,
  EDITOR_IMAGE_NODE,
  EDITOR_LINK_MARK,
  EDITOR_RAW_NODE,
} from "./extensions";

/** prosemirror-markdown 的 MarkSerializerSpec（其 d.ts 未导出，本地同构） */
interface MarkSerializerSpec {
  open:
    | string
    | ((
        state: MarkdownSerializerState,
        mark: PMMark,
        parent: PMNode,
        index: number
      ) => string);
  close:
    | string
    | ((
        state: MarkdownSerializerState,
        mark: PMMark,
        parent: PMNode,
        index: number
      ) => string);
  mixable?: boolean;
  expelEnclosingWhitespace?: boolean;
  escape?: boolean;
}

// ---------------------------------------------------------------------------
// @video 语法映射（生命线 2）
// ---------------------------------------------------------------------------

/**
 * 视频语法 → 带 marker title 的标准图片语法（markdown-it 原生 image 管线）。
 * marker 含零宽空格，正常内容不可能写出该 title（防"图片 title 恰好撞车"）；
 * image token handler 见到 marker 即产出 videoBlock 节点，marker 不落盘。
 */
const VIDEO_TITLE_MARKER = "\u200bvideo-block";

function preTransformVideoSyntax(md: string): string {
  const lines = md.split("\n");
  // 围栏感知：与渲染管线 renderVideoSyntax 同规（围栏内字样原样保留）
  const fenced = computeFencedLineFlags(lines);
  return lines
    .map((line, i) =>
      fenced[i]
        ? line
        : line.replace(VIDEO_SYNTAX_RE, (_m, alt: string, url: string) =>
            `![${alt}](${url} "${VIDEO_TITLE_MARKER}")`
          )
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// markdown-it 实例（default preset：tables/strikethrough 开、html/linkify 关）
// ---------------------------------------------------------------------------

function lineOffsets(src: string): number[] {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** markdown-it "default" preset + 本编辑器稳定化 core 规则 */
export function createEditorMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt("default", { html: false, linkify: false });

  // 1) text_special（md-it 14 的实体解码 token）合并进 text：
  //    prosemirror-markdown 的 tokenHandlers 没有 text 处理路径，不合并会抛
  //    "Token type not supported"
  md.core.ruler.push("editor_merge_text_special", (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== "inline" || !tok.children) continue;
      const out: Token[] = [];
      for (const t of tok.children) {
        const last = out[out.length - 1];
        if (t.type === "text_special" && last && last.type === "text") {
          last.content += t.content;
        } else if (t.type === "text_special") {
          const text = new state.Token("text", "", 0);
          text.content = t.content;
          out.push(text);
        } else {
          out.push(t);
        }
      }
      tok.children = out;
    }
  });

  // 2) 相邻纯媒体行合并问题：md-it 把相邻行归入同一段落，序列化后媒体块
  //    失去"块首"形态（媒体面板按块识别）。把 children 全为 image/softbreak
  //    的段落拆成每图一段（text 夹媒体的行内混排不拆，保持原样）。
  md.core.ruler.push("editor_split_media_paragraphs", (state) => {
    const toks = state.tokens;
    const out: Token[] = [];
    for (let i = 0; i < toks.length; i++) {
      const open = toks[i];
      const inline = toks[i + 1];
      const close = toks[i + 2];
      const isTriple =
        open?.type === "paragraph_open" &&
        inline?.type === "inline" &&
        close?.type === "paragraph_close";
      const children = isTriple ? inline.children : null;
      const mediaOnly =
        !!children &&
        children.length > 0 &&
        children.every((t) => t.type === "image" || t.type === "softbreak");
      if (isTriple && mediaOnly && !open.hidden && children) {
        // 分组：连续 image 各成一组；softbreak 是组间分隔（丢弃，块间空行承担）
        const groups: Token[][] = [];
        let current: Token[] | null = null;
        for (const t of children) {
          if (t.type === "softbreak") {
            current = null;
          } else {
            if (!current) {
              current = [];
              groups.push(current);
            }
            current.push(t);
          }
        }
        for (const group of groups) {
          out.push(open);
          const seg = new state.Token("inline", "", 0);
          seg.children = group;
          out.push(seg);
          out.push(close);
        }
        i += 2;
        continue;
      }
      out.push(toks[i]);
    }
    state.tokens = out;
  });

  // 3) 链接携带进图片：[![alt](src)](href) —— 图片节点无 mark，链接信息
  //    记入图片 attrs（linkHref），序列化时还原包裹，往返无损。
  md.core.ruler.push("editor_carry_link_into_image", (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== "inline" || !tok.children) continue;
      let href: string | null = null;
      let title: string | null = null;
      for (const t of tok.children) {
        if (t.type === "link_open") {
          href = t.attrGet("href");
          title = t.attrGet("title");
        } else if (t.type === "link_close") {
          href = null;
          title = null;
        } else if (t.type === "image" && href != null) {
          t.attrSet("data-link-href", href);
          if (title != null) t.attrSet("data-link-title", title);
        }
      }
    }
  });

  // 5) 生命线 2：marker title 的 image token → media_video_block token
  //    （videoBlock 节点）。链接携带的 data attrs 一并搬运。
  md.core.ruler.push("editor_video_tokens", (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== "inline" || !tok.children) continue;
      for (let i = 0; i < tok.children.length; i++) {
        const t = tok.children[i];
        if (t.type !== "image") continue;
        if (t.attrGet("title") !== VIDEO_TITLE_MARKER) continue;
        const vt = new state.Token("media_video_block", "", 0);
        vt.attrSet("alt", flattenAlt(t));
        vt.attrSet("url", t.attrGet("src") ?? "");
        const linkHref = t.attrGet("data-link-href");
        const linkTitle = t.attrGet("data-link-title");
        if (linkHref != null) vt.attrSet("linkHref", linkHref);
        if (linkTitle != null) vt.attrSet("linkTitle", linkTitle);
        tok.children[i] = vt;
      }
    }
  });

  // 6) 编辑器不建模的块 → media_raw_block token（rawMarkdown 节点原样保存）。
  //    目前：GFM 表格（table_open..table_close 按源文件行原样截取）。
  md.core.ruler.push("editor_collapse_raw_blocks", (state) => {
    const toks = state.tokens;
    const out: Token[] = [];
    const offsets = lineOffsets(state.src);
    const sliceLines = (fromLine: number, toLine: number): string => {
      const from = offsets[Math.min(fromLine, offsets.length - 1)] ?? 0;
      const to = offsets[Math.min(toLine, offsets.length)] ?? state.src.length;
      return state.src.slice(from, to).replace(/\n$/, "");
    };
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      if (tok.type === "table_open") {
        let j = i + 1;
        while (j < toks.length && toks[j].type !== "table_close") j++;
        const close = toks[j];
        const fromLine = tok.map?.[0] ?? 0;
        const toLine = close?.map?.[1] ?? tok.map?.[1] ?? fromLine;
        const raw = new state.Token("media_raw_block", "div", 0);
        raw.content = sliceLines(fromLine, toLine);
        raw.meta = { kind: "table" };
        out.push(raw);
        if (close) i = j;
        continue;
      }
      out.push(tok);
    }
    state.tokens = out;
  });

  return md;
}

// ---------------------------------------------------------------------------
// 解析：markdown → PM doc
// ---------------------------------------------------------------------------

/** markdown-it image token 的 alt = children 扁平化为纯文本（与站点渲染一致） */
function flattenAlt(tok: Token): string {
  if (!tok.children) return tok.content ?? "";
  return tok.children.map(flattenAlt).join("");
}

function langOf(info: string | undefined | null): string | null {
  const lang = (info ?? "").trim().split(/\s+/)[0];
  return lang ? lang : null;
}

export function buildEditorMarkdownParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(schema, createEditorMarkdownIt(), {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok) => ({ start: +(tok.attrGet("start") || 1) }),
    },
    heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (tok) => ({ language: langOf(tok.info) }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    image: {
      node: EDITOR_IMAGE_NODE,
      getAttrs: (tok) => ({
        src: tok.attrGet("src") ?? "",
        alt: flattenAlt(tok) || null,
        title: tok.attrGet("title") || null,
        linkHref: tok.attrGet("data-link-href"),
        linkTitle: tok.attrGet("data-link-title"),
      }),
    },
    media_video_block: {
      node: "videoBlock" as const,
      noCloseToken: true,
      getAttrs: (tok) => ({
        alt: tok.attrGet("alt"),
        url: tok.attrGet("url") ?? "",
        linkHref: tok.attrGet("linkHref"),
        linkTitle: tok.attrGet("linkTitle"),
      }),
    },
    hardbreak: { node: "hardBreak" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    link: {
      mark: EDITOR_LINK_MARK,
      getAttrs: (tok) => ({
        href: tok.attrGet("href") ?? "",
        title: tok.attrGet("title") || null,
      }),
    },
    code_inline: { mark: "code", noCloseToken: true },
    media_raw_block: {
      node: EDITOR_RAW_NODE,
      noCloseToken: true,
      getAttrs: (tok) => ({
        source: tok.content ?? "",
        kind: (tok.meta as { kind?: string } | null)?.kind ?? "raw",
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// 序列化：PM doc → markdown
// ---------------------------------------------------------------------------

function backticksFor(node: PMNode | null, side: number): string {
  const ticks = /`+/g;
  let m: RegExpExecArray | null;
  let len = 0;
  if (node && node.isText) {
    while ((m = ticks.exec(node.text ?? ""))) len = Math.max(len, m[0].length);
  }
  let result = len > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (len > 0 && side < 0) result += " ";
  return result;
}

function escAttrText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const nodeSerializers = {
  paragraph(state: MarkdownSerializerState, node: PMNode) {
    state.renderInline(node);
    state.closeBlock(node);
  },
  heading(state: MarkdownSerializerState, node: PMNode) {
    state.write(state.repeat("#", node.attrs.level) + " ");
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  bulletList(state: MarkdownSerializerState, node: PMNode) {
    state.renderList(node, "  ", () => "- ");
  },
  orderedList(state: MarkdownSerializerState, node: PMNode) {
    const start: number = node.attrs.start ?? 1;
    const maxW = String(start + node.childCount - 1).length;
    const space = state.repeat(" ", maxW + 2);
    state.renderList(node, space, (i) => {
      const nStr = String(start + i);
      return state.repeat(" ", maxW - nStr.length) + nStr + ". ";
    });
  },
  listItem(state: MarkdownSerializerState, node: PMNode) {
    state.renderContent(node);
  },
  blockquote(state: MarkdownSerializerState, node: PMNode) {
    state.wrapBlock("> ", null, node, () => state.renderContent(node));
  },
  codeBlock(state: MarkdownSerializerState, node: PMNode) {
    // 围栏加长硬化：内容含 ``` 行时加长围栏（防提前闭合）
    const backticks = node.textContent.match(/`{3,}/gm);
    const fence = backticks ? backticks.sort().slice(-1)[0] + "`" : "```";
    state.write(fence + (node.attrs.language || "") + "\n");
    state.text(node.textContent, false);
    state.write("\n");
    state.write(fence);
    state.closeBlock(node);
  },
  horizontalRule(state: MarkdownSerializerState, node: PMNode) {
    state.write("---");
    state.closeBlock(node);
  },
  image(state: MarkdownSerializerState, node: PMNode) {
    const alt = state.esc(node.attrs.alt || "");
    const title = node.attrs.title ? ` "${escAttrText(node.attrs.title)}"` : "";
    const inner =
      "![" +
      alt +
      "](" +
      (node.attrs.src || "").replace(/[\(\)]/g, "\\$&") +
      title +
      ")";
    const href: string | null = node.attrs.linkHref ?? null;
    if (href) {
      const linkTitle =
        node.attrs.linkTitle != null
          ? ` "${escAttrText(node.attrs.linkTitle)}"`
          : "";
      state.write("[" + inner + "](" + href.replace(/[\(\)"]/g, "\\$&") + linkTitle + ")");
    } else {
      state.write(inner);
    }
  },
  videoBlock(state: MarkdownSerializerState, node: PMNode) {
    // alt 由解析保证不含 "]"（@video 语法定义 [^\]]*）
    const alt = (node.attrs.alt || "").replace(/]/g, "");
    const inner = `@video[${alt}](${node.attrs.url})`;
    const href: string | null = node.attrs.linkHref ?? null;
    if (href) {
      const linkTitle =
        node.attrs.linkTitle != null
          ? ` "${escAttrText(node.attrs.linkTitle)}"`
          : "";
      state.write("[" + inner + "](" + href.replace(/[\(\)"]/g, "\$&") + linkTitle + ")");
    } else {
      state.write(inner);
    }
  },
  rawMarkdown(state: MarkdownSerializerState, node: PMNode) {
    state.write(node.attrs.source ?? "");
    state.closeBlock(node);
  },
  hardBreak(state: MarkdownSerializerState, node: PMNode, parent: PMNode, index: number) {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) {
        state.write("\\\n");
        return;
      }
    }
  },
  text(state: MarkdownSerializerState, node: PMNode) {
    state.text(node.text ?? "");
  },
};

const markSerializers: Record<string, MarkSerializerSpec> = {
  bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
  italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  code: {
    open(_state: unknown, _mark: unknown, parent: PMNode, index: number) {
      return backticksFor(parent.child(index), -1);
    },
    close(_state: unknown, _mark: unknown, parent: PMNode, index: number) {
      return backticksFor(parent.child(index - 1), 1);
    },
    escape: false,
  },
  [EDITOR_LINK_MARK]: {
    open: "[",
    close(_state: unknown, mark: PMMark) {
      const href = (mark.attrs.href ?? "").replace(/[\(\)"]/g, "\\$&");
      const title = mark.attrs.title ? ` "${escAttrText(mark.attrs.title)}"` : "";
      return "](" + href + title + ")";
    },
    mixable: true,
  },
};

/**
 * E5：文本中出现的 HTML 字面量（html:false 解析为纯文本）在序列化时转义——
 * `<` → `\<`、`&` → `\&`，再解析只会得到纯文本，原始 HTML 不会以可执行/
 * 可识别形态出现在任何输出里。
 */
const ESCAPE_EXTRA = /[<&]/g;

/**
 * MarkdownSerializerState 的运行时形态：d.ts 未声明 constructor 与 out（内部
 * 属性），但 MarkdownSerializer.serialize 内部正是如此构造使用（源码核对）。
 */
type RuntimeSerializerState = MarkdownSerializerState & {
  out: string;
};

function createSerializerState(nodes: typeof nodeSerializers): RuntimeSerializerState {
  const Ctor = MarkdownSerializerState as unknown as new (
    nodes: typeof nodeSerializers,
    marks: Record<string, MarkSerializerSpec>,
    options: Record<string, unknown>
  ) => RuntimeSerializerState;
  return new Ctor(nodes, markSerializers, {
    escapeExtraCharacters: ESCAPE_EXTRA,
    strict: false,
  });
}

export function serializeDocToMarkdown(doc: PMNode): string {
  const state = createSerializerState(nodeSerializers);
  state.renderContent(doc);
  return state.out.replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// 便捷封装（schema 单例：与 buildEditorExtensions 同源，测试/编辑器零漂移）
// ---------------------------------------------------------------------------

let cachedSchema: Schema | null = null;
let cachedParser: MarkdownParser | null = null;

export function getEditorSchema(): Schema {
  if (!cachedSchema) {
    cachedSchema = getSchema(buildEditorExtensions() as Extensions);
  }
  return cachedSchema;
}

export function getEditorMarkdownParser(): MarkdownParser {
  if (!cachedParser) {
    cachedParser = buildEditorMarkdownParser(getEditorSchema());
  }
  return cachedParser;
}

/**
 * image/videoBlock 是叶子节点，不应携带 mark：链接信息已由 carry 规则记入
 * attrs（linkHref），mark 若残留会导致序列化双包裹（attrs 包一层 + link
 * mark 再包一层），破坏定点稳定。解析后统一剥离。
 */
function stripMarksFromMediaNodes(doc: PMNode): PMNode {
  const mediaNames = new Set([EDITOR_IMAGE_NODE, "videoBlock"]);
  const holder: { tr: Transform | null } = { tr: null };
  doc.descendants((node, pos) => {
    if (mediaNames.has(node.type.name) && node.marks.length > 0) {
      const t = holder.tr ?? new Transform(doc);
      t.setNodeMarkup(pos, null, node.attrs, []);
      holder.tr = t;
    }
  });
  return holder.tr ? holder.tr.doc : doc;
}

/** markdown → PM doc（生命线 1 进；视频语法在围栏外映射为 videoBlock） */
export function parseMarkdownToDoc(md: string): PMNode {
  const doc = getEditorMarkdownParser().parse(preTransformVideoSyntax(md));
  return stripMarksFromMediaNodes(doc);
}

/** markdown → Tiptap setContent 用的 JSON */
export function markdownToEditorJson(md: string): Record<string, unknown> {
  return parseMarkdownToDoc(md).toJSON() as Record<string, unknown>;
}

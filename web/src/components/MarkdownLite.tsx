import type { ReactNode } from "react";

/**
 * Renders the small Markdown subset modpack descriptions use (FTB writes
 * Markdown; the server converts CurseForge's HTML to the same subset):
 * headings, paragraphs, lists, **bold**, *italic*, `code` and [links](https://…).
 * Everything becomes React elements — text is never parsed as HTML, so a
 * description can't inject markup or script. Images and stray HTML tags are
 * dropped; links must be http(s) and open in a new tab.
 */

type Block = { kind: "heading"; level: number; text: string } | { kind: "list"; items: string[] } | { kind: "paragraph"; lines: string[] };

const INLINE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`/g;

function clean(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/<[^>]+>/g, "") // stray HTML tags, as text
    .trimEnd();
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].replace(/#+$/, "").trim() });
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (item) {
      flush();
      // Items separated by blank lines still form one list.
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(item[1]);
      else blocks.push({ kind: "list", items: [item[1]] });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [, linkText, href, bold1, bold2, em1, em2, code] = match;
    const key = match.index;
    if (href) {
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {linkText}
        </a>
      );
    } else if (bold1 ?? bold2) out.push(<strong key={key}>{bold1 ?? bold2}</strong>);
    else if (em1 ?? em2) out.push(<em key={key}>{em1 ?? em2}</em>);
    else if (code) out.push(<code key={key}>{code}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="markdown-lite">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "heading") {
          return block.level <= 2 ? <h3 key={i}>{renderInline(block.text)}</h3> : <h4 key={i}>{renderInline(block.text)}</h4>;
        }
        if (block.kind === "list") {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {renderInline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

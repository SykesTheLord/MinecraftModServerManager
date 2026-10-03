/**
 * Turns a CurseForge project description (author-written HTML) into the small
 * Markdown subset the UI renders for FTB's descriptions too: headings,
 * paragraphs, list items, **bold**, *italic* and [links](https://…). The UI
 * builds React elements from that text and never injects HTML, so whatever
 * this misses can only come out as harmless literal text. Images, embeds and
 * scripts are dropped.
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const MAX_LENGTH = 20_000;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

export function htmlToMarkdownLite(html: string): string {
  let text = html
    .replace(/<(script|style|iframe|object|embed|svg|noscript)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      const heading = stripTags(inner).replace(/\s+/g, " ").trim();
      return heading ? `\n\n${"#".repeat(Math.min(Number(level) + 1, 4))} ${heading}\n\n` : "";
    })
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = stripTags(inner).replace(/\s+/g, " ").trim();
      const url = decodeEntities(href).trim();
      if (!label) return "";
      return /^https?:\/\//i.test(url) ? `[${label.replace(/[[\]]/g, "")}](${url.replace(/[()\s]/g, encodeURIComponent)})` : label;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => (stripTags(inner).trim() ? `**${inner.trim()}**` : ""))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => (stripTags(inner).trim() ? `*${inner.trim()}*` : ""))
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|li|table|tr|blockquote|section)>/gi, "\n\n");
  text = decodeEntities(stripTags(text))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}

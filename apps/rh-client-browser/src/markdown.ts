// A small, safe markdown renderer for notes in the Library: every character of the source is escaped first, then
// headings, lists, paragraphs, bold, italics, code, links (http/https only) and [[wikilinks]] are turned into tags.
// Notes come from paper abstracts and the user's vault, so no raw HTML is ever passed through.

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => `<a class="wikilink" data-stem="${target.trim()}">${label ?? target}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(source: string): string {
  const out: string[] = [];
  let list = false;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) out.push("</ul>");
    list = false;
  };
  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flush();
      closeList();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      flush();
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(item[1])}</li>`);
    } else if (!line.trim()) {
      flush();
      closeList();
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flush();
  closeList();
  return out.join("\n");
}

/**
 * Models answer in Markdown; Telegram understands a small HTML subset. This converts the common
 * constructs and leaves everything else as plain text. Callers fall back to plain text if Telegram
 * still rejects the result.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function markdownToHtml(md: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = md.replace(/\r\n/g, '\n');

  // Fenced code blocks (an unclosed fence runs to the end).
  s = s.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$(?![\s\S]))/g, (_, lang: string, code: string) => {
    const cls = lang ? ` class="language-${esc(lang)}"` : '';
    return hold(`<pre><code${cls}>${esc(code.replace(/\n$/, ''))}</code></pre>`);
  });

  // Markdown tables read badly in proportional fonts: show them monospaced.
  s = s.replace(/(?:^\|.*\|[ \t]*(?:\n|$))+/gm, (table) => {
    const rows = table.trimEnd().split('\n').filter((r) => !/^\|[\s|:-]+\|$/.test(r.trim()));
    return hold(`<pre>${esc(rows.join('\n'))}</pre>`) + '\n';
  });

  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${esc(code)}</code>`));

  s = esc(s);

  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) =>
    hold(`<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`),
  );
  s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '──────────');
  s = s.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '<b>$1</b>');
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, '$1<b>$2</b>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>');
  s = s.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block) => {
    const body = block.trimEnd().split('\n').map((l) => l.replace(/^&gt;[ \t]?/, '')).join('\n');
    return `<blockquote>${body}</blockquote>\n`;
  });

  // Placeholders can nest (a link around inline code), so restore until none are left.
  for (let i = 0; i < 3 && s.includes('\u0000'); i++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
  }
  return s.trim();
}

/** Strips Markdown syntax for the plain-text fallback. */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\w+#.-]*\n?/g, '')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .trim();
}

/**
 * Splits Markdown into pieces that stay under Telegram's 4096-character limit after conversion,
 * preferring paragraph and line boundaries and keeping code fences balanced.
 */
export function splitMarkdown(md: string, limit = 3500): string[] {
  const chunks: string[] = [];
  let cur = '';
  let fence: string | null = null;

  const flush = () => {
    if (!cur.trim()) return;
    chunks.push(fence !== null ? `${cur}\n\`\`\`` : cur);
    cur = fence !== null ? `\`\`\`${fence}\n` : '';
  };

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let line of lines) {
    while (line.length > limit) {
      if (cur) flush();
      cur += line.slice(0, limit);
      line = line.slice(limit);
      flush();
    }
    if (cur.length + line.length + 1 > limit) flush();
    // A blank line after a long-enough chunk is a good place to break.
    else if (line === '' && fence === null && cur.length > limit * 0.8) flush();
    cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line;
    const m = line.match(/^\s*```([\w+#.-]*)/);
    if (m) fence = fence === null ? m[1] : null;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.replace(/^\n+|\n+$/g, '')).filter(Boolean);
}

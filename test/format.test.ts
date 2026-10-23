import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToHtml, splitMarkdown } from '../src/format.ts';

test('converts common markdown to telegram html', () => {
  assert.equal(markdownToHtml('**bold** and *italic* and `x<y`'), '<b>bold</b> and <i>italic</i> and <code>x&lt;y</code>');
  assert.equal(markdownToHtml('# Title\n- one\n- two'), '<b>Title</b>\n• one\n• two');
  assert.equal(markdownToHtml('[site](https://a.b/c?d=1&e=2)'), '<a href="https://a.b/c?d=1&amp;e=2">site</a>');
  assert.equal(markdownToHtml('> quoted\n> more\nafter'), '<blockquote>quoted\nmore</blockquote>\nafter');
  assert.equal(markdownToHtml('~~gone~~'), '<s>gone</s>');
});

test('escapes html and leaves code untouched', () => {
  assert.equal(markdownToHtml('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(markdownToHtml('```js\nconst a = **b** < 1;\n```'), '<pre><code class="language-js">const a = **b** &lt; 1;</code></pre>');
});

test('does not italicize snake_case or arithmetic', () => {
  assert.equal(markdownToHtml('use snake_case_names here'), 'use snake_case_names here');
  assert.equal(markdownToHtml('2 * 3 * 4'), '2 * 3 * 4');
});

test('tables become monospaced blocks', () => {
  const html = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |\n\nend');
  assert.match(html, /^<pre>\| a \| b \|\n\| 1 \| 2 \|<\/pre>/);
  assert.match(html, /end$/);
});

test('splits long text and keeps code fences balanced', () => {
  const code = '```\n' + Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n```';
  const chunks = splitMarkdown(`intro\n\n${code}\n\noutro`, 500);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(c.length <= 520, `chunk too long: ${c.length}`);
    assert.equal((c.match(/```/g) ?? []).length % 2, 0, 'unbalanced fence');
  }
  assert.equal(splitMarkdown('short').length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImport } from '../server/importArchive.mjs';

const article = (id = 1, extra = {}) => ({
  id, slug: `post-${id}`, title: `Post ${id}`, description: 'A public article',
  sourceUrl: `https://dev.to/dessygil/post-${id}`, canonicalUrl: `https://dev.to/dessygil/post-${id}`,
  publishedAt: '2026-10-01T12:00:00Z', updatedAt: null, readingTimeMinutes: 4, tags: ['javascript', 'science'],
  coverImage: 'https://media2.dev.to/example.png', originalCoverImage: 'https://media2.dev.to/example.png',
  bodyHtml: `<p>Full article ${id}</p>`, bodyMarkdown: `Full article ${id}`,
  author: { name: 'Desmond Gilmour', username: 'dessygil', profileUrl: 'https://dev.to/dessygil' }, ...extra,
});

test('merges new and edited articles, preserves missing old posts, and sorts newest first', () => {
  const existing = [article(1), article(2)];
  const payload = { articles: [article(1, { title: 'Edited post', updatedAt: '2026-11-11T12:00:00Z' }), article(3, { publishedAt: '2026-11-10T12:00:00Z' })] };
  const before = structuredClone({ existing, payload });
  const result = validateImport(payload, existing);
  assert.deepEqual(result.map(post => post.id), [3, 1, 2]);
  assert.equal(result.find(post => post.id === 1).title, 'Edited post');
  assert.deepEqual({ existing, payload }, before);
  assert.notEqual(result.find(post => post.id === 2), existing[1]);
});

test('rejects wrong authors, mismatched source URLs and invalid IDs or slugs', () => {
  const invalid = [
    article(1, { id: -1 }), article(1, { id: 1.5 }), article(1, { slug: '../bad' }),
    article(1, { sourceUrl: 'https://dev.to/other/post-1' }),
    article(1, { sourceUrl: 'https://dev.to/dessygil/post-1?extra=true' }),
    article(1, { author: { name: 'Other', username: 'other', profileUrl: 'https://dev.to/other' } }),
  ];
  for (const post of invalid) assert.throws(() => validateImport({ articles: [post] }, []), /Invalid writing import/);
});

test('rejects duplicate incoming IDs, duplicate slugs and collisions with preserved posts', () => {
  assert.throws(() => validateImport({ articles: [article(1), article(1)] }, []), /duplicate IDs/);
  const sameSlug = article(2, { slug: 'post-1', sourceUrl: 'https://dev.to/dessygil/post-1' });
  assert.throws(() => validateImport({ articles: [article(1), sameSlug] }, []), /duplicate slugs/);
  assert.throws(() => validateImport({ articles: [sameSlug] }, [article(1)]), /duplicate slugs/);
});

test('accepts HTTPS covers or unchanged stored local assets only; canonical URLs use HTTP(S)', () => {
  const stored = article(1, { coverImage: '/writing-assets/example.png' });
  assert.equal(validateImport({ articles: [stored] }, [stored])[0].coverImage, stored.coverImage);
  assert.throws(() => validateImport({ articles: [stored] }, []), /absolute URL/);
  assert.throws(() => validateImport({ articles: [article(1, { coverImage: '/writing-assets/other.png' })] }, [stored]), /absolute URL/);
  assert.throws(() => validateImport({ articles: [article(1, { coverImage: 'http://example.com/a.png' })] }, []), /HTTPS/);
  assert.throws(() => validateImport({ articles: [article(1, { coverImage: 'https://user:pass@example.com/a.png' })] }, []), /credentials/);
  assert.throws(() => validateImport({ articles: [article(1, { canonicalUrl: 'javascript:alert(1)' })] }, []), /HTTP or HTTPS/);
  assert.equal(validateImport({ articles: [article(1, { canonicalUrl: 'http://example.com/post' })] }, [])[0].canonicalUrl, 'http://example.com/post');
});

test('rejects malformed dates, oversized content, invalid tags and empty imports', () => {
  const invalid = [
    article(1, { publishedAt: 'not-a-date' }), article(1, { updatedAt: '2026-02-31T12:00:00Z' }),
    article(1, { bodyHtml: 'a'.repeat(500001) }), article(1, { title: 'a'.repeat(501) }),
    article(1, { tags: ['safe', '<script>'] }), article(1, { readingTimeMinutes: '4' }),
  ];
  for (const post of invalid) assert.throws(() => validateImport({ articles: [post] }, []), /Invalid writing import/);
  assert.throws(() => validateImport({ articles: [] }, [article(1)]), /1 to 1000/);
  assert.throws(() => validateImport({ articles: null }, []), /1 to 1000/);
});

test('sanitizes unsafe HTML, keeps code and tables, and rewrites links to merged local posts', () => {
  const post = article(1, { bodyHtml: '<h1 id="intro">Intro</h1><script>alert(1)</script><iframe src="https://example.com"></iframe><p onclick="bad()">Text</p><pre><code>&lt;script&gt;literal&lt;/script&gt;</code></pre><table><tr><td>Value</td></tr></table><a href="https://dev.to/dessygil/post-2#detail">Read more</a>' });
  const result = validateImport({ articles: [post] }, [article(2)]);
  const html = result.find(item => item.id === 1).bodyHtml;
  assert.doesNotMatch(html, /<h1|<script|<iframe|onclick/);
  assert.match(html, /<h2 id="intro">Intro<\/h2>/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.match(html, /<td>Value<\/td>/);
  assert.match(html, /href="\/writing\/post-2#detail"/);
});

test('failed validation leaves existing data and payload unchanged', () => {
  const existing = [article(1)];
  const payload = { articles: [article(2), article(3, { bodyHtml: '<script>only unsafe content</script>' })] };
  const before = structuredClone({ existing, payload });
  Object.freeze(existing[0]);
  Object.freeze(existing);
  assert.throws(() => validateImport(payload, existing), /no safe readable content/);
  assert.deepEqual({ existing, payload }, before);
});

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeBody, syncDevto } from "../server/devto.mjs";

const published = "2026-10-01T12:00:00Z";
const edited = "2026-11-10T12:00:00Z";
const summary = (id, editedAt = null) => ({ id, edited_at: editedAt, user: { username: "dessygil" } });
const sourceArticle = (id, extra = {}) => ({
  id, slug: `post-${id}`, title: `Post ${id}`, description: "An article",
  url: `https://dev.to/dessygil/post-${id}`, canonical_url: `https://dev.to/dessygil/post-${id}`,
  published_at: published, edited_at: null, reading_time_minutes: 3,
  tags: ["javascript"], cover_image: "https://media2.dev.to/example.png",
  body_html: `<h2 id="example">Example</h2><p>Article ${id}</p>`,
  body_markdown: `## Example\n\nArticle ${id}`,
  user: { username: "dessygil", name: "Desmond Gilmour" }, ...extra,
});
const storedArticle = (id, extra = {}) => ({
  id, slug: `post-${id}`, title: `Post ${id}`, description: "An article",
  sourceUrl: `https://dev.to/dessygil/post-${id}`, canonicalUrl: `https://dev.to/dessygil/post-${id}`,
  publishedAt: published, updatedAt: null, readingTimeMinutes: 3, tags: ["javascript"],
  coverImage: "/writing-assets/old.png", originalCoverImage: "https://media2.dev.to/example.png",
  bodyHtml: `<p>Stored article ${id}</p>`, bodyMarkdown: `Stored article ${id}`,
  author: { username: "dessygil", name: "Desmond Gilmour", profileUrl: "https://dev.to/dessygil" }, ...extra,
});
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});
function mockApi({ pages, full = {}, responses = {} }) {
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://dev.to");
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(url.pathname + url.search);
    const queue = responses[url.pathname + url.search] || responses[url.pathname];
    if (queue?.length) return queue.shift();
    if (url.pathname === "/api/articles") {
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("username"), "dessygil");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.ok(page in pages, `Unexpected page ${page}`);
      return jsonResponse(pages[page]);
    }
    const id = Number(url.pathname.split("/").at(-1));
    assert.ok(id in full, `Unexpected full-article request ${id}`);
    return jsonResponse(full[id]);
  };
  return { fetcher, calls };
}

test("imports new posts across all pages, fetches edited posts only, and retains absent posts", async () => {
  const existing = [storedArticle(1), storedArticle(2), storedArticle(99)];
  const before = structuredClone(existing);
  const api = mockApi({
    pages: { 1: [summary(1), summary(2, edited)], 2: [summary(3)], 3: [] },
    full: {
      2: sourceArticle(2, { edited_at: edited, title: "Updated second post" }),
      3: sourceArticle(3, { published_at: "2026-11-11T10:00:00Z" }),
    },
  });
  const result = await syncDevto({ existing, fetcher: api.fetcher });
  assert.deepEqual(existing, before);
  assert.deepEqual({ imported: result.imported, updated: result.updated, sourceCount: result.sourceCount },
    { imported: 1, updated: 1, sourceCount: 3 });
  assert.equal(result.articles.length, 4);
  assert.equal(result.articles[0].id, 3);
  assert.equal(result.articles.find(article => article.id === 2).title, "Updated second post");
  assert.equal(result.articles.find(article => article.id === 1).coverImage, "/writing-assets/old.png");
  assert.ok(result.articles.some(article => article.id === 99));
  assert.deepEqual(api.calls.filter(call => /^\/api\/articles\//.test(call)), ["/api/articles/2", "/api/articles/3"]);
});

test("preserves the entire input if one full-article fetch fails", async () => {
  const existing = [storedArticle(1)];
  const before = structuredClone(existing);
  Object.freeze(existing[0]);
  Object.freeze(existing);
  const api = mockApi({
    pages: { 1: [summary(2), summary(3)], 2: [] },
    full: { 2: sourceArticle(2) },
    responses: { "/api/articles/3": [jsonResponse({ error: "Not found" }, 404)] },
  });
  await assert.rejects(syncDevto({ existing, fetcher: api.fetcher }), /HTTP 404/);
  assert.deepEqual(existing, before);
});

test("retries a rate-limited API response and respects a zero retry-after", async () => {
  const api = mockApi({
    pages: { 1: [summary(1)], 2: [] }, full: { 1: sourceArticle(1) },
    responses: { "/api/articles?username=dessygil&per_page=100&page=1": [jsonResponse({}, 429, { "retry-after": "0" })] },
  });
  const result = await syncDevto({ existing: [], fetcher: api.fetcher });
  assert.equal(result.imported, 1);
  assert.equal(api.calls.filter(call => call.endsWith("page=1")).length, 2);
});

test("rejects unexpected authors, repeated pagination, and redirects", async () => {
  const wrongAuthor = mockApi({ pages: { 1: [{ ...summary(1), user: { username: "someone-else" } }] } });
  await assert.rejects(syncDevto({ existing: [], fetcher: wrongAuthor.fetcher }), /unexpected author/);
  const repeated = mockApi({ pages: { 1: [summary(1)], 2: [summary(1)] } });
  await assert.rejects(syncDevto({ existing: [], fetcher: repeated.fetcher }), /repeated a page/);
  const redirect = mockApi({ pages: {}, responses: { "/api/articles": [new Response(null, { status: 302, headers: { location: "https://example.com" } })] } });
  await assert.rejects(syncDevto({ existing: [], fetcher: redirect.fetcher }), /redirected/);
});

test("does not discard archived posts when the public feed is empty", async () => {
  const existing = [storedArticle(7)];
  const api = mockApi({ pages: { 1: [] } });
  const result = await syncDevto({ existing, fetcher: api.fetcher });
  assert.deepEqual(result.articles, existing);
  assert.equal(result.sourceCount, 0);
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 0);
});

test("rejects duplicate final slugs instead of producing conflicting article routes", async () => {
  const api = mockApi({
    pages: { 1: [summary(2)], 2: [] },
    full: { 2: sourceArticle(2, { slug: "post-1" }) },
  });
  await assert.rejects(syncDevto({ existing: [storedArticle(1)], fetcher: api.fetcher }), /slugs conflict/);
});

test("sanitizes active content while preserving code, tables, headings, images, and own-post anchors", () => {
  const unsafe = `<script>alert(1)</script><style>body{display:none}</style>
    <form action="https://example.com"><input name="secret"><button>Submit</button></form>
    <iframe src="https://example.com"></iframe><svg onload="alert(1)"><script>alert(2)</script></svg>
    <h2 id="sample"><a name="sample" href="#sample">Example</a></h2>
    <pre class="highlight"><code>&lt;script&gt;literal code&lt;/script&gt;</code></pre>
    <table><tbody><tr><td colspan="2">Value</td></tr></tbody></table>
    <div class="highlight__panel">Broken fullscreen controls</div>
    <img src="https://media2.dev.to/picture.png" onerror="alert(3)" srcset="https://example.com/x 2x">
    <a href="javascript:alert(4)">Unsafe link</a>
    <a href="https://dev.to/dessygil/post-2?ref=feed#sample" target="_blank">Own article</a>`;
  const safe = sanitizeBody(unsafe, [storedArticle(2)]);
  assert.doesNotMatch(safe, /<script|<style|<form|<input|<button|<iframe|<svg|onerror|onload|srcset|javascript:|Broken fullscreen/);
  assert.match(safe, /<h2 id="sample"><a name="sample" href="#sample">Example<\/a><\/h2>/);
  assert.match(safe, /&lt;script&gt;literal code&lt;\/script&gt;/);
  assert.match(safe, /<td colspan="2">Value<\/td>/);
  assert.match(safe, /src="https:\/\/media2.dev.to\/picture.png" loading="lazy"/);
  assert.match(safe, /href="\/writing\/post-2#sample" target="_blank" rel="noopener noreferrer"/);
});

test("sanitizes newly imported content and rewrites links to posts discovered later in the feed", async () => {
  const api = mockApi({
    pages: { 1: [summary(1), summary(2)], 2: [] },
    full: {
      1: sourceArticle(1, { body_html: '<p onclick="alert(1)"><a href="/dessygil/post-2#section">Next</a></p>' }),
      2: sourceArticle(2),
    },
  });
  const result = await syncDevto({ existing: [], fetcher: api.fetcher });
  assert.equal(result.articles[0].bodyHtml, '<p><a href="/writing/post-2#section">Next</a></p>');
});


test("only code and table scroll containers receive controlled keyboard focus attributes", () => {
  const source = '<p tabindex="12">Intro</p><pre tabindex="-1" role="button" aria-label="Untrusted" aria-labelledby="fake" onfocus="bad()"><code tabindex="8">const x = 1;</code></pre><table tabindex="7" role="presentation" aria-label="Untrusted table"><caption>Measurements</caption><tbody><tr><td>Value</td></tr></tbody></table>';
  const safe = sanitizeBody(source);
  assert.match(safe, /<pre\b[^>]*tabindex="0"/);
  assert.match(safe, /<pre\b[^>]*role="region"/);
  assert.match(safe, /<pre\b[^>]*aria-label="Code block \(scroll horizontally\)"/);
  assert.match(safe, /<table tabindex="0"><caption>Measurements<\/caption>/);
  assert.match(safe, /<code>const x = 1;<\/code>/);
  assert.equal((safe.match(/tabindex=/g) || []).length, 2);
  assert.doesNotMatch(safe, /tabindex="(?:-1|[1-9])|aria-labelledby|onfocus|Untrusted|role="(?:button|presentation)"/);
  assert.equal(sanitizeBody(safe), safe);
});

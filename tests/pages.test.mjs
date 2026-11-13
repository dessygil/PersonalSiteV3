import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sanitizeBody } from '../server/devto.mjs';

// Exercise the actual shared React components using the Worker JSX resolution.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'des-pages-tests-'));
after(() => rm(temporary, { recursive: true, force: true }));
const bundled = join(temporary, 'pages.cjs');
await build({
  entryPoints: [join(root, 'server/pages.mjs')], outfile: bundled,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  alias: Object.fromEntries(['react', 'react-dom', 'react-router', 'react-router-dom'].map(name => [name, join(root, 'client/node_modules', name)])),
  loader: { '.js': 'jsx', '.css': 'empty', '.jpg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.pdf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const { metadata, renderPage, sitemap, rss } = (await import(pathToFileURL(bundled).href)).default;

const origin = 'https://des.example.com';
const template = '<!doctype html><html lang="en"><head><title>Default</title><meta name="description" content="Default"/></head><body><noscript>Please enable JavaScript to explore this website.</noscript><div id="root"></div></body></html>';
const article = (id = 1, extra = {}) => ({
  id, slug: `post-${id}`, title: `Article ${id}`, description: `Description ${id}`,
  sourceUrl: `https://dev.to/dessygil/post-${id}`, canonicalUrl: `https://dev.to/dessygil/post-${id}`,
  publishedAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-10T13:30:00Z',
  readingTimeMinutes: 4, tags: ['javascript', 'science'], coverImage: '/writing-assets/example.png',
  bodyHtml: '<h2 id="details">Details</h2><p>A complete paragraph found only in the body.</p><pre><code>const result = 42;</code></pre><table><tbody><tr><td>Measured value</td></tr></tbody></table>',
  bodyMarkdown: '## Details\n\nA complete paragraph found only in the body.',
  author: { name: 'Desmond Gilmour', username: 'dessygil' }, ...extra,
});
const withoutScripts = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
test('writing dashboard shell is noindex and never contains private statistics', () => {
  const html = renderPage(template, [article()], '/dashboard/writing', origin);
  assert.match(html, /Private writing dashboard/);
  assert.match(html, /noindex/);
  assert.match(html, /return_to=%2Fdashboard%2Fwriting/);
  assert.ok(!html.includes('Page not found'));
  assert.ok(!html.includes('websiteViews'));
});
test('article static HTML offers local sharing and question links', () => {
  const html = renderPage(template, [article()], '/writing/post-1', origin);
  assert.match(html, /sharing\/share-offsite/);
  assert.ok(html.includes(encodeURIComponent(`${origin}/writing/post-1`)));
  assert.ok(html.includes('/?article=post-1#Contact-anchor'));
});
test('article question prefill is present in HTML without JavaScript and uses only known articles', () => {
  const html = renderPage(template, [article()], '/', origin, value => value, {}, '?article=post-1');
  assert.match(html, /I have a question about your article/);
  assert.ok(html.includes(`${origin}/writing/post-1`));
  const unknown = renderPage(template, [article()], '/', origin, value => value, {}, '?article=not-published');
  assert.ok(!unknown.includes('I have a question about your article'));
});
function schema(html) {
  const found = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(found, 'JSON-LD must be present');
  return JSON.parse(found[1]);
}
function bootstrap(html) {
  const found = html.match(/<script>(window\.__WRITING_ARTICLES__=[\s\S]*?)<\/script>/);
  assert.ok(found, 'Article bootstrap must be present');
  assert.ok(!found[1].includes('<'));
  assert.ok(!found[1].includes('\u2028'));
  assert.ok(!found[1].includes('\u2029'));
  const context = { window: {} };
  runInNewContext(found[1], context, { timeout: 100 });
  assert.equal(context.injected, undefined);
  return JSON.parse(JSON.stringify(context.window.__WRITING_ARTICLES__));
}

test('article metadata includes local share URL, original canonical, image, dates and BlogPosting', () => {
  const post = article();
  const meta = metadata([post], '/writing/post-1', origin);
  assert.equal(meta.title, 'Article 1 | Desmond Gilmour');
  assert.equal(meta.description, post.description);
  assert.ok(meta.tags.includes('rel="canonical" href="https://dev.to/dessygil/post-1"'));
  assert.ok(meta.tags.includes('property="og:url" content="https://des.example.com/writing/post-1"'));
  assert.ok(meta.tags.includes('property="og:image" content="https://des.example.com/writing-assets/example.png"'));
  assert.ok(meta.tags.includes('name="twitter:card" content="summary_large_image"'));
  assert.ok(meta.tags.includes('property="article:published_time" content="2026-11-01T12:00:00Z"'));
  assert.ok(meta.tags.includes('property="article:modified_time" content="2026-11-10T13:30:00Z"'));
  const data = schema(meta.tags);
  assert.equal(data['@type'], 'BlogPosting');
  assert.equal(data.headline, post.title);
  assert.equal(data.author.name, 'Desmond Gilmour');
  assert.equal(data.datePublished, post.publishedAt);
  assert.equal(data.dateModified, post.updatedAt);
  assert.equal(data.url, `${origin}/writing/post-1`);
  assert.equal(data.mainEntityOfPage, post.canonicalUrl);
});

test('full article body, code and tables are present without JavaScript', () => {
  const html = withoutScripts(renderPage(template, [article()], '/writing/post-1', origin, sanitizeBody));
  assert.ok(html.includes('<title>Article 1 | Desmond Gilmour</title>'));
  assert.ok(html.includes('<meta name="description" content="Description 1"/>'));
  assert.ok(html.includes('<div id="root"><a class="skip-to-content"'));
  assert.ok(html.includes('<main class="site-main" id="main">'));
  assert.ok(html.includes('<h1 id="article-heading">Article 1</h1>'));
  assert.ok(html.includes('<p>A complete paragraph found only in the body.</p>'));
  assert.ok(html.includes('<code>const result = 42;</code>'));
  assert.ok(html.includes('<td>Measured value</td>'));
  assert.match(html, /<pre\b[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label="Code block \(scroll horizontally\)"/);
  assert.match(html, /<table tabindex="0">/);
  assert.ok(html.includes('Originally published on <a href="https://dev.to/dessygil/post-1">DEV.to</a>'));
});

test('archive lists every article with title and description without JavaScript', () => {
  const posts = [article(1), article(2), article(3)];
  const html = renderPage(template, posts, '/writing', origin, sanitizeBody);
  const readable = withoutScripts(html);
  assert.ok(readable.includes('<title>Writing | Desmond Gilmour</title>'));
  assert.ok(readable.includes('All 3 articles'));
  for (const post of posts) {
    assert.ok(readable.includes(`href="/writing/${post.slug}"`));
    assert.ok(readable.includes(post.title));
    assert.ok(readable.includes(post.description));
  }
  assert.equal(schema(html)['@type'], 'Blog');
});

test('hostile metadata cannot escape attributes, JSON-LD or bootstrap script', () => {
  const payload = `</script><script>globalThis.injected=true</script>"<&'\u2028\u2029`;
  const post = article(1, {
    title: payload, description: payload, tags: [payload],
    canonicalUrl: `https://dev.to/dessygil/post-1?value=${payload}`,
    coverImage: `https://media2.dev.to/image.png?value=${payload}`,
    bodyHtml: '<p>Normal content</p><script>globalThis.injected=true</script>', bodyMarkdown: payload,
  });
  const html = renderPage(template, [post], '/writing/post-1', origin, sanitizeBody);
  assert.equal((html.match(/<script\b/g) || []).length, 3);
  assert.equal((html.match(/<\/script>/g) || []).length, 3);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;'));
  assert.ok(!html.includes('<script>globalThis.injected'));
  assert.equal(schema(html).headline, payload);
  const { bodyMarkdown, ...initialArticle } = post;
  assert.deepEqual(bootstrap(html), [initialArticle]);
});

test('replacement-like dollar sequences survive rendering and bootstrap intact', () => {
  const special = "$& $' $` $$";
  const post = article(1, {
    title: `Tokens: ${special}`, description: `Characters: ${special}`,
    bodyHtml: `<p>Literal tokens: ${special}</p>`, bodyMarkdown: `Literal tokens: ${special}`,
  });
  const html = renderPage(template, [post], '/writing/post-1', origin, sanitizeBody);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.equal((html.match(/<\/head>/g) || []).length, 1);
  const { bodyMarkdown, ...initialArticle } = post;
  assert.deepEqual(bootstrap(html), [initialArticle]);
  assert.equal(schema(html).headline, post.title);
});

test('h1-led article hierarchy shifts once and leaves page title as the only h1', () => {
  const body = '<h1 id="overview">Overview</h1><h2 id="details">Details</h2><h3>Subsection</h3><h5>Deep</h5><h6>Deepest</h6><pre><code>&lt;h1&gt;literal&lt;/h1&gt;</code></pre>';
  const normalized = sanitizeBody(body);
  assert.ok(!normalized.includes('<h1'));
  assert.ok(normalized.includes('<h2 id="overview">Overview</h2>'));
  assert.ok(normalized.includes('<h3 id="details">Details</h3>'));
  assert.ok(normalized.includes('<h4>Subsection</h4>'));
  assert.ok(normalized.includes('<h6>Deep</h6><h6>Deepest</h6>'));
  assert.ok(normalized.includes('&lt;h1&gt;literal&lt;/h1&gt;'));
  assert.equal(sanitizeBody(normalized), normalized);
  const html = withoutScripts(renderPage(template, [article(1, { bodyHtml: body })], '/writing/post-1', origin, sanitizeBody));
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
});

test('h2-led content, escaped code and script text do not trigger a heading shift', () => {
  const body = '<h2 id="details">Details</h2><p><code>&lt;h1&gt;</code></p><script>"<h1>"</script>';
  assert.equal(sanitizeBody(body), '<h2 id="details">Details</h2><p><code>&lt;h1&gt;</code></p>');
});

test('article table of contents uses unique stable anchors and preserves legacy targets', () => {
  const body = '<h2>Overview &amp; context</h2><h3>Overview &amp; context</h3><h2 id="overview-context-2">Original</h2><h2><a name="legacy-target"></a>Legacy <em>heading</em></h2><h2 id="main">Reserved page ID</h2><h4></h4><pre><code>&lt;h2&gt;Not a heading&lt;/h2&gt;</code></pre>';
  const html = withoutScripts(renderPage(template, [article(1, { bodyHtml: body })], '/writing/post-1', origin, sanitizeBody));
  assert.ok(html.includes('<nav class="article-toc" aria-label="On this page">'));
  for (const id of ['overview-context', 'overview-context-3', 'overview-context-2', 'legacy-target', 'main-2']) {
    assert.ok(html.includes(`href="#${id}"`), `TOC link missing: ${id}`);
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `Anchor must be unique: ${id}`);
  }
  assert.ok(html.includes('Legacy heading</a>'));
  assert.ok(!html.includes('>Not a heading</a>'));
  assert.ok(!html.includes('href="#section"'));
  assert.ok(html.includes('href="/writing/topics/javascript"'));
  assert.ok(html.includes('href="/writing/topics/science"'));
});

test('sitemap includes profile, tag collections and articles with real modification dates', () => {
  const posts = [article(1), article(2), article(3)];
  const xml = sitemap(posts, origin);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.deepEqual(urls, [`${origin}/`, `${origin}/writing`, `${origin}/writing/topics/javascript`, `${origin}/writing/topics/science`, ...posts.map(post => `${origin}/writing/${post.slug}`)]);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(!xml.includes('https://dev.to/'));
  assert.ok(!xml.includes('/projects'));
  assert.equal((xml.match(/<lastmod>/g) || []).length, posts.length);
  assert.ok(xml.includes('<lastmod>2026-11-10T13:30:00.000Z</lastmod>'));
});

test('homepage renders résumé, education, project evidence and current writing without JavaScript', () => {
  const post = article(700, { title: 'A newly synchronized article' });
  const html = renderPage(template, [post], '/', origin);
  const readable = withoutScripts(html);
  assert.equal((readable.match(/<h1\b/g) || []).length, 1);
  for (const text of ['Desmond', 'Gilmour', 'Account Executive', '228%', 'University of Guelph', 'Physical Sciences', 'Computer Science', 'Vintage Academy', 'A newly synchronized article']) assert.ok(readable.includes(text), `Missing visible ${text}`);
  assert.ok(readable.includes('id="Experience-anchor"'));
  assert.ok(!readable.includes('Please enable JavaScript'));
  assert.ok(readable.includes('href="mailto:desmondgilmour@gmail.com"'));
  assert.ok(readable.includes('href="/writing/post-700"'));
  assert.ok(!readable.includes('A complete paragraph found only in the body.'));
  const data = bootstrap(html);
  assert.equal(data.length, 1);
  assert.equal(data[0].bodyHtml, undefined);
  assert.equal(data[0].bodyMarkdown, undefined);
});

test('profile schema identifies the person and matches article authors across routes', () => {
  const profile = metadata([article()], '/', origin);
  assert.equal(profile.title, 'Desmond Gilmour | Experience, projects & writing');
  const data = schema(profile.tags);
  assert.equal(data['@type'], 'ProfilePage');
  assert.equal(data.mainEntity['@id'], `${origin}/#person`);
  assert.equal(data.mainEntity.jobTitle, 'Account Executive');
  assert.equal(data.mainEntity.worksFor.name, 'Nicoya');
  assert.equal(data.mainEntity.alumniOf.name, 'University of Guelph');
  assert.equal(data.mainEntity.hasCredential.length, 2);
  assert.deepEqual(data.mainEntity.sameAs, ['https://www.linkedin.com/in/desmondgilmour', 'https://github.com/dessygil', 'https://dev.to/dessygil']);
  assert.equal(data.mainEntity.image, `${origin}/media/desmond-gilmour-640.webp`);
  assert.deepEqual(schema(metadata([article()], '/writing/post-1', origin).tags).author, data.mainEntity);
  assert.ok(profile.tags.includes('type="application/rss+xml"'));
  assert.ok(profile.tags.includes(`href="${origin}/feed.xml"`));
  assert.equal(profile.noindex, false);
});

test('topic collections render matching articles with distinct metadata before JavaScript', () => {
  const posts = [article(1), article(2, { tags: ['science'] }), article(3, { tags: ['other'] })];
  const path = '/writing/topics/science';
  const html = renderPage(template, posts, path, origin);
  const readable = withoutScripts(html);
  assert.equal((readable.match(/<h1\b/g) || []).length, 1);
  assert.ok(readable.includes('href="/writing/post-1"'));
  assert.ok(readable.includes('href="/writing/post-2"'));
  assert.ok(!readable.includes('href="/writing/post-3"'));
  assert.equal(schema(html)['@type'], 'CollectionPage');
  assert.equal(schema(html).mainEntity.itemListElement.length, 2);
  assert.equal(metadata(posts, path, origin).noindex, false);
  assert.ok(metadata(posts, path, origin).title.includes('Writing | Desmond Gilmour'));
  assert.equal(metadata(posts, path, origin).canonical, `${origin}${path}`);
});

test('missing routes have a server-rendered 404 and noindex metadata', () => {
  for (const path of ['/unknown', '/writing/missing', '/writing/topics/missing', '/projects', '/projects/missing']) {
    const html = renderPage(template, [], path, origin);
    assert.ok(withoutScripts(html).includes('<h1>Page not found.</h1>'));
    assert.ok(html.includes('<meta name="robots" content="noindex, follow"/>'));
    assert.equal(metadata([], path, origin).noindex, true);
  }
  assert.ok(!metadata([], '/writing', origin).tags.includes('noindex'));
});

test('personal article canonicals activate only on the actual public HTTPS origin', () => {
  const post = article();
  const path = `/writing/${post.slug}`;
  const publicMeta = metadata([post], path, 'https://desmondgilmour.com');
  assert.equal(publicMeta.canonical, `https://desmondgilmour.com${path}`);
  assert.equal(publicMeta.schema.mainEntityOfPage, publicMeta.canonical);
  for (const previewOrigin of [origin, 'http://desmondgilmour.com', 'https://www.desmondgilmour.com', 'https://desmondgilmour.com.example.net', 'https://desmondgilmour.com:8443']) {
    const meta = metadata([post], path, previewOrigin);
    assert.equal(meta.canonical, post.sourceUrl);
    assert.equal(meta.schema.mainEntityOfPage, post.sourceUrl);
    assert.ok(!meta.tags.includes(`rel="canonical" href="https://desmondgilmour.com${path}"`));
  }
  const importedWithFutureCanonical = { ...post, canonicalUrl: `https://desmondgilmour.com${path}` };
  assert.equal(metadata([importedWithFutureCanonical], path, origin).canonical, post.sourceUrl);
});

test('article bootstrap contains only the requested body and no Markdown', () => {
  const posts = [article(1), article(2), article(3)];
  const data = bootstrap(renderPage(template, posts, '/writing/post-2', origin));
  assert.deepEqual(data.map(item => Boolean(item.bodyHtml)), [false, true, false]);
  assert.ok(data.every(item => !Object.hasOwn(item, 'bodyMarkdown')));
});

test('RSS contains absolute local article links, source attribution and excerpts only', () => {
  const posts = [article(1), article(2, { publishedAt: '2026-11-03T09:00:00Z' })];
  const xml = rss(posts, origin);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.equal((xml.match(/<item>/g) || []).length, 2);
  assert.ok(xml.indexOf('<title>Article 2</title>') < xml.indexOf('<title>Article 1</title>'));
  assert.ok(xml.includes(`<atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml"/>`));
  assert.ok(xml.includes(`<link>${origin}/writing/post-1</link>`));
  assert.ok(xml.includes('Originally published on DEV.to: https://dev.to/dessygil/post-1'));
  assert.ok(xml.includes('<pubDate>Sun, 01 Nov 2026 12:00:00 GMT</pubDate>'));
  assert.ok(xml.includes('<lastBuildDate>Tue, 10 Nov 2026 13:30:00 GMT</lastBuildDate>'));
  assert.ok(!xml.includes('A complete paragraph found only in the body.'));
  assert.ok(!xml.includes('bodyMarkdown'));
});

test('RSS escapes XML delimiters, strips invalid controls and handles an empty archive', () => {
  const xml = rss([article(1, { title: 'Science & <software> "notes"', description: "A & B < C\u0000", tags: ['a&b'], sourceUrl: 'https://dev.to/dessygil/post-1?a=1&b=2' })], origin);
  assert.ok(xml.includes('<title>Science &amp; &lt;software&gt; &quot;notes&quot;</title>'));
  assert.ok(xml.includes('A &amp; B &lt; C'));
  assert.ok(xml.includes('?a=1&amp;b=2'));
  assert.ok(xml.includes('<category>a&amp;b</category>'));
  assert.ok(!xml.includes('\u0000'));
  assert.ok(!rss([], origin).includes('<lastBuildDate>'));
  assert.ok(!rss([], origin).includes('<item>'));
});

test('homepage exposes the approved training widget and inbox form without leaking arbitrary settings', () => {
 const config = { contact: { endpoint: '/api/contact' }, strava: { widgetUrl: 'https://www.strava.com/athletes/123/latest-rides/approved-widget', summaryWidgetUrl: 'https://www.strava.com/athletes/123/activity-summary/approved-widget', profileUrl: 'https://www.strava.com/athletes/123' }, analytics: { enabled: false }, privateKey: '</script><script>injected=true</script>' };
 const html = renderPage(template, [article()], '/', origin, sanitizeBody, config);
 assert.ok(html.includes('Training for a half Ironman.'));
 assert.ok(html.includes('action="/api/contact"'));
 assert.ok(html.includes('Load Strava activity'));
 assert.ok(!html.includes('<iframe'));
 assert.ok(!html.includes('privateKey'));
 assert.ok(!html.includes('<script>injected=true'));
 assert.ok(html.includes('window.__SITE_CONFIG__='));
 assert.ok(html.includes(config.strava.summaryWidgetUrl));
 assert.ok(!html.includes('The race distances'));
 const writing = html.indexOf('id="Blog-anchor"'), training = html.indexOf('id="Training-anchor"'), projects = html.indexOf('id="Portfolio-anchor"');
 assert.ok(writing >= 0 && writing < training && training < projects);
 assert.ok(html.includes('04 / WRITING') && html.includes('05 / STRAVA') && html.includes('06 / PROJECTS'));
 const archive = html.indexOf('class="project-archive"');
 assert.ok(archive > projects && archive < html.indexOf('</section>', projects));
});

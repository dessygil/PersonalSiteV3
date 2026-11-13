import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkHostedSite, collectReferences, publicExternalUrl, classifyExternalStatus, validateConfig, SITE_ORIGIN } from '../scripts/check-hosted-site.mjs';

const token = 'fake-monitor-access-token';
const now = Date.parse('2026-11-11T14:00:00Z');
const config = { url: SITE_ORIGIN, token };
const articlePath = '/writing/one-article';
const topicPath = '/writing/topics/science';
const html = body => `<html><head><title>Site</title><link rel="stylesheet" href="/static/site.css"></head><body><main id="main">${body}</main></body></html>`;
const article = { slug: 'one-article', title: 'A & B', bodyHtml: '<h2>Body</h2>Full article', tags: ['science'] };
const defaultPages = () => new Map([
  ['/api/health', { type: 'application/json', body: JSON.stringify({ status: 'ok', articleCount: 1, lastSyncedAt: new Date(now - 1000).toISOString() }) }],
  ['/api/articles', { type: 'application/json', body: JSON.stringify([article]) }],
  ['/sitemap.xml', { type: 'application/xml', body: `<urlset>${['/', '/writing', articlePath, topicPath].map(path => `<url><loc>${SITE_ORIGIN}${path}</loc></url>`).join('')}</urlset>` }],
  ['/feed.xml', { type: 'application/rss+xml', body: `<rss><channel><item><link>${SITE_ORIGIN}${articlePath}</link></item></channel></rss>` }],
  ['/', { type: 'text/html', body: html('<h1>Desmond Gilmour</h1><a href="/writing">Writing</a><img src="/portrait.png"><script>const x="<a href=\'https://hidden.example.org\'>hidden</a>";</script>') }],
  ['/writing', { type: 'text/html', body: html(`<h1>All 1 articles</h1><a href="${articlePath}">A &amp; B</a>`) }],
  [articlePath, { type: 'text/html', body: html('<h1>A &amp; B</h1><div class="article-prose"><h2 id="body">Body</h2>Full article</div><a href="#body">Section</a>') }],
  [topicPath, { type: 'text/html', body: html('<h1>Science</h1>Topic articles') }],
  ['/portrait.png', { type: 'image/png', body: 'fake-image-bytes' }],
  ['/static/site.css', { type: 'text/css', body: 'body { color: #111; }' }],
]);
function fixture({ pages = defaultPages(), external = () => new Response(null, { status: 200 }), anonymous } = {}) {
  const requests = [];
  const fetcher = async (input, options) => {
    const url = new URL(input);
    requests.push({ url: url.href, options });
    assert.ok(['GET', 'HEAD'].includes(options.method));
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.credentials, 'omit');
    if (url.origin !== SITE_ORIGIN) {
      assert.equal(new Headers(options.headers).has('Authorization'), false);
      assert.equal(new Headers(options.headers).has('OAI-Sites-Authorization'), false);
      assert.equal(options.redirect, 'manual');
      assert.equal(url.href.includes(token), false);
      return external(url, options);
    }
    if (!new Headers(options.headers).has('OAI-Sites-Authorization')) {
      assert.equal(typeof anonymous, 'function');
      assert.equal(new Headers(options.headers).has('Authorization'), false);
      assert.equal(new Headers(options.headers).has('Cookie'), false);
      assert.equal(options.redirect, 'error');
      return anonymous(url, options, pages);
    }
    assert.equal(new Headers(options.headers).get('OAI-Sites-Authorization'), `Bearer ${token}`);
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    assert.equal(options.redirect, 'error');
    assert.notEqual(url.pathname, '/api/sync-devto');
    const page = pages.get(url.pathname);
    return new Response(page?.body || 'Missing', { status: page?.status || (page ? 200 : 404), headers: { 'Content-Type': page?.type || 'text/html' } });
  };
  return { fetcher, requests, pages };
}
const run = (f, input = config) => checkHostedSite(input, { fetcher: f.fetcher, now: () => now });

test('checks private home, writing, every article, topic, RSS, sitemap, assets and fresh sync with read-only requests', async () => {
  const f = fixture();
  const result = await run(f);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.checked.pages, 4);
  assert.equal(result.checked.images, 1);
  assert.equal(result.checked.assets, 1);
  assert.equal(result.checked.requests, 10);
  assert.equal(result.checked.externalLinks, 0);
  assert.equal(result.checked.publicPages, 0);
  assert.deepEqual(result.publicAccess, { expected: false, ok: null });
  assert.ok(f.requests.every(request => request.url.startsWith(SITE_ORIGIN)));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('parser ignores links inside script text, decodes attributes and finds headings, anchors and srcset images', () => {
  const parsed = collectReferences('<h1>A &amp; B</h1><h2 id="a&amp;b">A</h2><a href="/writing?q=a&amp;b=2">Read</a><img srcset="/a.png 1x, /b.png 2x"><script>let x="<a href=\"https://ignore.example.org\">"</script>', SITE_ORIGIN);
  assert.equal(parsed.hasHeading, true);
  assert.ok(parsed.ids.has('a&b'));
  assert.ok(parsed.text.includes('A & B'));
  assert.ok(parsed.references.some(reference => reference.url.endsWith('?q=a&b=2')));
  assert.equal(parsed.references.filter(reference => reference.kind === 'image').length, 2);
  assert.ok(parsed.references.every(reference => !reference.url.includes('ignore.example.org')));
});

test('reports stale sync, broken page, missing image and broken section without writing', async () => {
  const f = fixture();
  f.pages.get('/api/health').body = JSON.stringify({ status: 'ok', articleCount: 1, lastSyncedAt: new Date(now - 49 * 3600000).toISOString() });
  f.pages.get('/').body = html('<h1>Desmond Gilmour</h1><a href="/missing">Missing</a><img src="/absent.png"><a href="#unknown">Section</a>');
  const result = await run(f);
  assert.equal(result.ok, false);
  for (const kind of ['freshness', 'page', 'image', 'anchor']) assert.ok(result.failures.some(issue => issue.kind === kind), kind);
});

test('detects a sign-in shell or missing full article text despite HTTP 200', async () => {
  const f = fixture();
  f.pages.get(articlePath).body = html('<h1>Sign in</h1><div class="article-prose"></div>Continue to this private website');
  const result = await run(f);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(issue => issue.kind === 'article'));
  assert.ok(result.failures.some(issue => /Expected page/.test(issue.reason)));
});

test('requires valid health JSON, complete RSS and complete sitemap', async () => {
  const f = fixture();
  f.pages.get('/api/health').body = 'null';
  f.pages.get('/feed.xml').body = '<rss><channel></channel></rss>';
  f.pages.get('/sitemap.xml').body = '<urlset></urlset>';
  const result = await run(f);
  assert.equal(result.ok, false);
  for (const kind of ['freshness', 'rss', 'sitemap']) assert.ok(result.failures.some(issue => issue.kind === kind), kind);
});

test('external checks are opt-in, unauthenticated, and distinguish blocked/timeout links from confirmed missing links', async () => {
  const pages = defaultPages();
  pages.get('/').body = html('<h1>Desmond Gilmour</h1>' + ['blocked', 'limited', 'missing', 'gone', 'timeout'].map(name => `<a href="https://${name}.example.org/path?private=tracking">${name}</a>`).join(''));
  const f = fixture({ pages, external(url) {
    if (url.hostname.startsWith('timeout')) throw new Error('Timeout');
    return new Response(null, { status: { blocked: 403, limited: 429, missing: 404, gone: 410 }[url.hostname.split('.')[0]] });
  } });
  assert.equal((await run(f)).checked.externalLinks, 0);
  const result = await run(f, { ...config, checkExternalLinks: true });
  assert.equal(result.checked.externalLinks, 5);
  assert.equal(result.failures.filter(issue => issue.kind === 'external').length, 2);
  assert.equal(result.warnings.filter(issue => issue.kind === 'external').length, 3);
  assert.ok(result.warnings.every(issue => !issue.url.includes('?')));
});

test('falls back from unsupported external HEAD to GET and safely handles redirects without credentials', async () => {
  const pages = defaultPages();
  pages.get('/').body = html('<h1>Desmond Gilmour</h1><a href="https://headless.example.org/post">Post</a><a href="https://redirect.example.org/post">Redirect</a>');
  const f = fixture({ pages, external(url, options) {
    if (url.hostname === 'redirect.example.org') return new Response(null, { status: 302, headers: { Location: 'https://target.example.org/post' } });
    if (url.hostname === 'headless.example.org' && options.method === 'HEAD') return new Response(null, { status: 405 });
    return new Response('Readable', { status: 200 });
  } });
  const result = await run(f, { ...config, checkExternalLinks: true });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 0);
  assert.ok(f.requests.some(request => request.url.includes('headless.example.org') && request.options.method === 'GET'));
  assert.ok(f.requests.some(request => request.url.includes('target.example.org')));
});

test('never sends private addresses, reflected credentials, plain HTTP or same-origin redirected URLs to external fetches', async () => {
  const pages = defaultPages();
  pages.get('/').body = html(`<h1>Desmond Gilmour</h1><a href="https://localhost/">Local</a><a href="http://127.0.0.1/">IP</a><a href="http://plain.example.org/">HTTP</a><a href="https://reflect.example.org/?secret=${token}">Reflection</a><a href="https://redirect.example.org/">Redirect</a>`);
  const f = fixture({ pages, external: () => new Response(null, { status: 302, headers: { Location: `${SITE_ORIGIN}/api/sync-devto` } }) });
  const result = await run(f, { ...config, checkExternalLinks: true });
  assert.ok(result.warnings.length >= 3);
  assert.equal(f.requests.filter(request => new URL(request.url).origin !== SITE_ORIGIN).length, 1);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('rejects foreign origins and malformed configuration before requests; classifies HTTP failures conservatively', async () => {
  let called = false;
  await assert.rejects(checkHostedSite({ ...config, url: 'https://example.org' }, { fetcher() { called = true; } }));
  assert.equal(called, false);
  for (const bad of [undefined, {}, { ...config, token: 'bad\nsecret' }, { ...config, checkExternalLinks: 'yes' }, { ...config, expectPublic: 'true' }, { ...config, url: `${SITE_ORIGIN}?token=x` }]) assert.throws(() => validateConfig(bad));
  for (const url of ['http://localhost', 'https://localhost./', 'https://intranet.internal./', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://intranet.internal/', 'https://name:password@example.org/', 'https://example.org:8443/']) assert.equal(publicExternalUrl(url), null);
  assert.equal(classifyExternalStatus(404), 'broken');
  assert.equal(classifyExternalStatus(403), 'unverified');
  assert.equal(classifyExternalStatus(500), 'unverified');
  assert.equal(classifyExternalStatus(200), 'ok');
});

test('CLI malformed-input output stays structured and never echoes input secrets', () => {
  let output;
  try { execFileSync(process.execPath, ['scripts/check-hosted-site.mjs'], { input: '{fake-private-value\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { assert.equal(error.status, 1); output = error.stdout; }
  assert.ok(output);
  assert.equal(output.includes('fake-private-value'), false);
  assert.equal(JSON.parse(output.trim().split('\n').at(-1)).ok, false);
});


test('public launch checks home, writing, and a full article anonymously without cookies or redirects', async () => {
  const f = fixture({ anonymous(url, options, pages) {
    const page = pages.get(url.pathname);
    return new Response(page.body, { status: 200, headers: { 'Content-Type': page.type } });
  } });
  const result = await run(f, { ...config, expectPublic: true });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.checked.publicPages, 3);
  assert.equal(result.checked.requests, 13);
  assert.deepEqual(result.publicAccess, { expected: true, ok: true });
  const anonymous = f.requests.filter(request => !new Headers(request.options.headers).has('OAI-Sites-Authorization'));
  assert.deepEqual(anonymous.map(request => new URL(request.url).pathname), ['/', '/writing', articlePath]);
  for (const request of anonymous) {
    assert.equal(new Headers(request.options.headers).has('Authorization'), false);
    assert.equal(new Headers(request.options.headers).has('Cookie'), false);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
  }
});

test('a 200 sign-in gate cannot pass the public check even when authenticated checks are healthy and the owner name appears', async () => {
  const f = fixture({ anonymous() {
    return new Response(html('<h1>Sign in</h1><p>Desmond Gilmour — sign in to read these articles.</p>'), { status: 200, headers: { 'Content-Type': 'text/html' } });
  } });
  const result = await run(f, { ...config, expectPublic: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.publicAccess, { expected: true, ok: false });
  assert.ok(result.failures.some(failure => failure.kind === 'public-access' && failure.url === SITE_ORIGIN + '/'));
  assert.ok(result.failures.every(failure => failure.kind === 'public-access'));
});

test('public access rejects redirects and authorization failures without following or authenticating them', async () => {
  for (const status of [302, 401, 403]) {
    const f = fixture({ anonymous() {
      return new Response(null, { status, headers: { Location: 'https://auth.example.org/signin' } });
    } });
    const result = await run(f, { ...config, expectPublic: true });
    assert.equal(result.ok, false);
    assert.equal(result.publicAccess.ok, false);
    assert.equal(result.failures.filter(failure => failure.kind === 'public-access' && failure.status === status).length, 3);
    assert.ok(f.requests.every(request => new URL(request.url).origin === SITE_ORIGIN));
  }
});

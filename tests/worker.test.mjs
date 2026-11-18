import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../dist/server/index.js';

const snapshot = JSON.parse(await readFile(new URL('../client/src/data/articles.json', import.meta.url)));
const origin = 'https://example.test';
const archiveKey = 'writing/archive-v1.json';
const previousKey = 'writing/previous-v1.json';
const fakeToken = 'fake-worker-integration-token.not-a-real-secret';
const WRITING_SERVICE_TOKEN_SHA256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fakeToken))), byte => byte.toString(16).padStart(2, '0')).join('');
const authenticatedEnv = BUCKET => ({ WRITING_SERVICE_TOKEN_SHA256, ...(BUCKET ? { BUCKET } : {}) });
const withoutScripts = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

function storage() {
  const objects = new Map();
  return {
    objects,
    get value() { return objects.get(archiveKey) ?? null; },
    set value(next) { if (next === null) objects.delete(archiveKey); else objects.set(archiveKey, next); },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { json: async () => JSON.parse(value) };
    },
    async put(key, next) { objects.set(key, next); },
  };
}

function newArticle() {
  return {
    ...snapshot[0],
    id: 999999999,
    slug: 'new-runtime-post',
    title: 'A new runtime post',
    description: 'Arrived after the deployment.',
    sourceUrl: 'https://dev.to/dessygil/new-runtime-post',
    canonicalUrl: 'https://dev.to/dessygil/new-runtime-post',
    publishedAt: '2026-11-11T14:00:00Z',
    updatedAt: null,
    readingTimeMinutes: 1,
    tags: ['science'],
    coverImage: null,
    originalCoverImage: null,
    bodyHtml: '<p>Complete new article body.</p>',
    bodyMarkdown: 'Complete new article body.',
    author: { username: 'dessygil', name: 'Desmond Gilmour', profileUrl: 'https://dev.to/dessygil' },
  };
}

function requestImport(articles, expectedLastSyncedAt = null, overrides = {}) {
  const headers = new Headers({
    Authorization: `Bearer ${fakeToken}`,
    'X-Des-Sync': 'devto-v1',
    'Content-Type': 'application/json',
  });
  const { headers: changes = {}, ...options } = overrides;
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(`${origin}/api/sync-devto`, {
    method: 'POST',
    body: JSON.stringify({ articles, expectedLastSyncedAt }),
    ...options,
    headers,
  });
}

test('Authenticated writer persists new posts and backs up the previous archive on a later update', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  const incoming = [...snapshot, newArticle()];
  const result = await worker.fetch(requestImport(incoming), env);
  assert.equal(result.status, 200);
  const imported = await result.json();
  assert.equal(imported.status, 'synced');
  assert.equal(imported.imported, 1);
  assert.equal(imported.count, snapshot.length + 1);

  const saved = JSON.parse(BUCKET.value);
  assert.equal(saved.articles.length, snapshot.length + 1);
  assert.equal(saved.lastSyncedAt, imported.lastSyncedAt);
  assert.equal(BUCKET.objects.has(previousKey), false);
  const page = await worker.fetch(new Request(`${origin}/writing/new-runtime-post`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Complete new article body\./);
  assert.match(html, /property="og:title" content="A new runtime post/);
  assert.match(await (await worker.fetch(new Request(`${origin}/sitemap.xml`), env)).text(), /new-runtime-post/);
  const archive = await (await worker.fetch(new Request(`${origin}/api/articles`), env)).json();
  assert.ok(archive.some(article => article.id === 999999999 && article.bodyHtml.includes('Complete new article body.')));
  const status = await (await worker.fetch(new Request(`${origin}/api/sync-status`), env)).json();
  assert.equal(status.lastSyncedAt, saved.lastSyncedAt);
  assert.equal(status.count, snapshot.length + 1);

  const beforeUpdate = BUCKET.value;
  const edited = saved.articles.map(article => article.id === 999999999
    ? { ...article, title: 'An updated runtime post' }
    : article);
  const update = await worker.fetch(requestImport(edited, saved.lastSyncedAt), env);
  assert.equal(update.status, 200);
  assert.equal((await update.json()).updated, 1);
  assert.equal(JSON.parse(BUCKET.value).articles.find(article => article.id === 999999999).title, 'An updated runtime post');
  assert.equal(BUCKET.objects.get(previousKey), beforeUpdate);
  assert.notEqual(BUCKET.objects.get(previousKey), BUCKET.value);
});

test('Writer rejects a stale archive revision without changing either storage object', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  const incoming = [...snapshot, newArticle()];
  assert.equal((await worker.fetch(requestImport(incoming), env)).status, 200);
  const before = new Map(BUCKET.objects);
  const stale = await worker.fetch(requestImport(incoming, null), env);
  assert.equal(stale.status, 409);
  assert.deepEqual(BUCKET.objects, before);
});

test('Writer rejects invalid author, malformed JSON, and malformed payload without changing storage', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  assert.equal((await worker.fetch(requestImport(snapshot), env)).status, 200);
  const before = BUCKET.value;
  const revision = JSON.parse(before).lastSyncedAt;
  const wrongAuthor = { ...newArticle(), author: { username: 'someone-else', name: 'Someone Else', profileUrl: 'https://dev.to/someone-else' } };
  const invalidRequests = [
    requestImport([...snapshot, wrongAuthor], revision),
    requestImport('not-an-array', revision),
    requestImport([], revision, { body: '{broken JSON' }),
    requestImport([], revision, { body: JSON.stringify({ expectedLastSyncedAt: revision }) }),
    requestImport(snapshot, revision, { headers: { 'Content-Type': 'text/plain' } }),
  ];
  for (const request of invalidRequests) {
    assert.equal((await worker.fetch(request, env)).status, 400);
    assert.equal(BUCKET.value, before);
  }
});

test('Writer requires the bearer credential even when the static sync header is present', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  const invalidRequests = [
    requestImport(snapshot, null, { headers: { Authorization: null } }),
    requestImport(snapshot, null, { headers: { Authorization: 'Bearer wrong-test-token' } }),
    requestImport(snapshot, null, { headers: { Authorization: null, 'OAI-Sites-Authorization': `Bearer ${fakeToken}` } }),
  ];
  for (const request of invalidRequests) {
    assert.equal(request.headers.get('X-Des-Sync'), 'devto-v1');
    assert.equal((await worker.fetch(request, env)).status, 401);
    assert.equal(BUCKET.value, null);
  }
  assert.equal((await worker.fetch(requestImport(snapshot), { BUCKET })).status, 401);
  assert.equal((await worker.fetch(requestImport(snapshot), { BUCKET, WRITING_SERVICE_TOKEN_SHA256: 'malformed' })).status, 401);
});

test('Valid authorization retains method, sync header, origin, and storage guards', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  assert.equal((await worker.fetch(new Request(`${origin}/api/sync-devto`), env)).status, 405);
  assert.equal((await worker.fetch(requestImport(snapshot, null, { headers: { 'X-Des-Sync': null } }), env)).status, 403);
  assert.equal((await worker.fetch(requestImport(snapshot, null, { headers: { Origin: 'https://other.test' } }), env)).status, 403);
  assert.equal((await worker.fetch(requestImport(snapshot), authenticatedEnv())).status, 503);
  assert.equal(BUCKET.value, null);
});

test('Article detail API serves runtime content without exposing the raw Markdown field', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  assert.equal((await worker.fetch(requestImport([...snapshot, newArticle()]), env)).status, 200);
  const response = await worker.fetch(new Request(`${origin}/api/articles/new-runtime-post`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  const detail = await response.json();
  assert.equal(detail.title, 'A new runtime post');
  assert.equal(detail.bodyHtml, '<p>Complete new article body.</p>');
  assert.equal(Object.hasOwn(detail, 'bodyMarkdown'), false);
  const missing = await worker.fetch(new Request(`${origin}/api/articles/not-real`), env);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Article not found.');
});

test('RSS uses the current stored archive and links to local article pages', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  assert.equal((await worker.fetch(requestImport([...snapshot, newArticle()]), env)).status, 200);
  const response = await worker.fetch(new Request(`${origin}/feed.xml`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/rss\+xml/);
  const xml = await response.text();
  assert.match(xml, /<rss\b/);
  assert.match(xml, /<channel>/);
  assert.ok(xml.includes('A new runtime post'));
  assert.ok(xml.includes(`${origin}/writing/new-runtime-post`));
});

test('Health reports initial, current, and overdue synchronization states', async () => {
  const initial = await worker.fetch(new Request(`${origin}/api/health`), {});
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { status: 'awaiting-sync', articleCount: snapshot.length, lastSyncedAt: null });
  const BUCKET = storage();
  const now = new Date().toISOString();
  BUCKET.value = JSON.stringify({ articles: snapshot, lastSyncedAt: now });
  const healthy = await (await worker.fetch(new Request(`${origin}/api/health`), { BUCKET })).json();
  assert.equal(healthy.status, 'ok');
  assert.equal(healthy.lastSyncedAt, now);
  assert.equal(healthy.articleCount, snapshot.length);
  BUCKET.value = JSON.stringify({ articles: snapshot, lastSyncedAt: new Date(Date.now() - 49 * 3600000).toISOString() });
  const overdue = await (await worker.fetch(new Request(`${origin}/api/health`), { BUCKET })).json();
  assert.equal(overdue.status, 'sync-overdue');
});

test('Fallback articles and bundled assets remain available without storage', async () => {
  const page = await worker.fetch(new Request(`${origin}/writing/${snapshot[0].slug}`), {});
  assert.equal(page.status, 200);
  assert.match(await page.text(), /class="article-prose"/);
  const image = await worker.fetch(new Request(`${origin}/writing-social.png`), {});
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.ok((await image.arrayBuffer()).byteLength > 1000);
  assert.equal((await worker.fetch(new Request(`${origin}/writing/not-real`), {})).status, 404);
});

test('Storage failures preserve the current archive and a valid previous backup', async () => {
  const BUCKET = storage();
  const env = authenticatedEnv(BUCKET);
  assert.equal((await worker.fetch(requestImport(snapshot), env)).status, 200);
  const before = BUCKET.value;
  const saved = JSON.parse(before);
  const changed = saved.articles.map((article, index) => index === 0 ? { ...article, description: 'A verified update.' } : article);
  const put = BUCKET.put.bind(BUCKET);
  BUCKET.put = async (key, value) => {
    if (key === previousKey) throw new Error('Simulated backup write failure');
    return put(key, value);
  };
  assert.equal((await worker.fetch(requestImport(changed, saved.lastSyncedAt), env)).status, 502);
  assert.equal(BUCKET.value, before);
  assert.equal(BUCKET.objects.has(previousKey), false);
  BUCKET.put = async (key, value) => {
    if (key === archiveKey) throw new Error('Simulated archive write failure');
    return put(key, value);
  };
  assert.equal((await worker.fetch(requestImport(changed, saved.lastSyncedAt), env)).status, 502);
  assert.equal(BUCKET.value, before);
  assert.equal(BUCKET.objects.get(previousKey), before);
});

test('Storage read failures keep fallback articles readable and report degraded health', async () => {
  let writes = 0;
  const BUCKET = {
    async get() { throw new Error('Simulated storage read failure'); },
    async put() { writes += 1; },
  };
  const response = await worker.fetch(new Request(`${origin}/api/articles`), { BUCKET });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, snapshot.length);
  const health = await worker.fetch(new Request(`${origin}/api/health`), { BUCKET });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).status, 'storage-unavailable');
  const failedWrite = await worker.fetch(requestImport(snapshot), authenticatedEnv(BUCKET));
  assert.equal(failedWrite.status, 502);
  assert.equal(writes, 0);
});

test('Topic routes resolve known archive tags and reject unknown topics', async () => {
  const { getWritingTopics } = await import('../client/src/lib/writingTopics.js');
  const topic = getWritingTopics(snapshot)[0];
  assert.ok(topic);
  const response = await worker.fetch(new Request(`${origin}/writing/topics/${topic.slug}`), {});
  assert.equal(response.status, 200);
  const html = withoutScripts(await response.text());
  assert.ok(html.includes(topic.articles[0].title));
  assert.equal((await worker.fetch(new Request(`${origin}/writing/topics/topic-that-does-not-exist-xyz`), {})).status, 404);
});

test('www.ca public pages redirect to the primary domain without redirecting private API requests', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/writing', `/writing/${snapshot[0].slug}?from=profile%20link`, '/feed.xml', '/sitemap.xml', '/robots.txt', '/dashboard/writing']) {
      const result = await worker.fetch(new Request(`https://www.desmondgilmour.ca${path}`, { method }), {});
      assert.equal(result.status, 308);
      assert.equal(result.headers.get('Location'), `https://desmondgilmour.ca${path}`);
    }
  }
  const api = await worker.fetch(new Request('https://www.desmondgilmour.ca/api/private/writing-dashboard'), {});
  assert.equal(api.status, 401); assert.equal(api.headers.get('Location'), null);
  const post = await worker.fetch(new Request('https://www.desmondgilmour.ca/writing', { method: 'POST' }), {});
  assert.equal(post.status, 405); assert.equal(post.headers.get('Location'), null);
  for (const hostname of ['desmondgilmour.ca', 'www.desmondgilmour.ca.example.test', 'www.desmondgilmour.com']) {
    const result = await worker.fetch(new Request(`https://${hostname}/writing`), {});
    assert.equal(result.status, 200); assert.equal(result.headers.get('Location'), null);
  }
});

test('recorded article visits flow into the private date-range report through the built Worker', async t => {
  const siteOrigin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
  const objects = new Map(); let revision = 0, clock = Date.parse('2026-11-14T02:00:00Z');
  t.mock.method(Date, 'now', () => clock);
  const BUCKET = {
    async get(key) {
      const saved = objects.get(key);
      return saved ? { etag: saved.etag, size: saved.text.length, json: async () => JSON.parse(saved.text) } : null;
    },
    async put(key, text, options) {
      const current = objects.get(key), condition = options?.onlyIf;
      if (condition?.etagDoesNotMatch === '*' && current) return null;
      if (condition?.etagMatches !== undefined && condition.etagMatches !== current?.etag) return null;
      const etag = String(++revision); objects.set(key, { text, etag }); return { etag };
    },
    async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
  };
  const env = { ...authenticatedEnv(BUCKET), ANALYTICS_ENABLED: 'true' };
  async function visit(path) {
    const result = await worker.fetch(new Request(`${siteOrigin}/api/analytics`, {
      method: 'POST', headers: { Origin: siteOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'pageview', path, referrer: null }),
    }), env);
    assert.equal(result.status, 202);
  }
  const [first, second] = snapshot;
  await visit(`/writing/${first.slug}`); await visit(`/writing/${first.slug}`);
  clock = Date.parse('2026-11-14T16:00:00Z');
  await visit(`/writing/${second.slug}`); await visit('/');
  const url = `${siteOrigin}/api/private/writing-dashboard?range=custom&from=2026-11-13&to=2026-11-13&article=${first.slug}`;
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  const result = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${fakeToken}` } }), env);
  assert.equal(result.status, 200); assert.match(result.headers.get('Cache-Control'), /private, no-store/);
  const report = await result.json();
  assert.equal(report.period.totalWebsiteViews, 2);
  assert.deepEqual(report.period.daily, [{ day: '2026-11-13', views: 2 }]);
  assert.equal(report.articles.find(article => article.slug === second.slug).periodWebsiteViews, 0);
  assert.equal(report.articles.find(article => article.slug === second.slug).websiteViews, 1);
  assert.equal(report.totals.websiteViews, 3);
});

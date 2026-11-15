import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWritingDashboard } from '../server/writingDashboard.mjs';
import fallback from '../client/src/data/article-index.json' with { type: 'json' };

const origin = 'https://desmondgilmour.com', snapshotKey = 'writing/dashboard-external-v1.json';
const endpoint = '/api/private/writing-dashboard', manualEndpoint = '/api/private/writing-stats', devEndpoint = '/api/private/devto-stats';
const articles = fallback.slice(0, 2), [first, second] = articles;
const now = Date.parse('2026-11-13T16:00:00.000Z'), asOf = '2026-11-12T12:00:00.000Z';
const token = 'test-only-dashboard-service', secret = 'test-only-devto-key';
const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join('');
const ownerHeaders = { 'oai-authenticated-user-id': 'verified-owner-id', 'oai-authenticated-user-email': 'OWNER@example.test' };
class Bucket {
  constructor() { this.objects = new Map(); this.calls = []; this.revision = 0; this.conflicts = 0; this.pageSize = 500; }
  seed(key, value) { this.objects.set(key, { text: JSON.stringify(value), etag: String(++this.revision) }); }
  value(key) { return JSON.parse(this.objects.get(key).text); }
  async get(key) { this.calls.push(['get', key]); const value = this.objects.get(key); return value ? { etag: value.etag, size: new TextEncoder().encode(value.text).length, json: async () => JSON.parse(value.text) } : null; }
  async put(key, text, options) {
    this.calls.push(['put', key, options]);
    if (this.conflicts-- > 0) return null;
    const current = this.objects.get(key), condition = options?.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && current) return null;
    if (condition?.etagMatches !== undefined && condition.etagMatches !== current?.etag) return null;
    const value = { text, etag: String(++this.revision) }; this.objects.set(key, value); return { etag: value.etag };
  }
  async list({ prefix, limit, cursor }) {
    this.calls.push(['list', prefix]); const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = Number(cursor || 0), end = start + Math.min(limit, this.pageSize);
    return { objects: keys.slice(start, end).map(key => ({ key })), truncated: end < keys.length, cursor: end < keys.length ? String(end) : undefined };
  }
}
function env(bucket = new Bucket(), extra = {}) { return { BUCKET: bucket, WRITING_OWNER_EMAIL: 'owner@example.test', WRITING_SERVICE_TOKEN_SHA256: verifier, ANALYTICS_ENABLED: 'true', ...extra }; }
function seeded() { const bucket = new Bucket(); bucket.seed('writing/archive-v1.json', { articles }); return bucket; }
function request(path = endpoint, body, changes = {}) {
  const { auth = 'owner', headers = {}, ...options } = changes;
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth === 'owner' ? ownerHeaders : auth === 'service' ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body) }), ...options });
}
const imported = (platform = 'medium', slug = first.slug, views = 100, date = asOf) => ({ platform, asOf: date, articles: [{ slug, views, url: platform === 'devto' ? `https://dev.to/dessygil/${slug}` : platform === 'medium' ? 'https://medium.com/@dessygil/example-post' : 'https://dessygil.substack.com/p/example-post' }] });
const writes = bucket => bucket.calls.filter(([kind]) => kind === 'put');
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const remoteArticle = article => ({ id: article.id, slug: article.slug, user: { username: 'dessygil' }, url: article.sourceUrl, page_views_count: 42 });
const largePage = () => [remoteArticle(first), ...Array.from({ length: 99 }, (_, index) => ({ id: 900000 + index, slug: `unimported-${index}`, user: { username: 'dessygil' }, url: `https://dev.to/dessygil/unimported-${index}`, page_views_count: 10 }))];
function seedDay(bucket, day, firstViews = 0, secondViews = 0, extraPaths = {}) {
  bucket.seed(`analytics/${day}.json`, { version: 1, day, paths: { [`/writing/${first.slug}`]: { pageview: firstViews }, [`/writing/${second.slug}`]: { pageview: secondViews }, ...extraPaths } });
}
async function readDashboard(bucket, query = '') {
  const result = await handleWritingDashboard(request(endpoint + query), env(bucket));
  assert.equal(result.status, 200); return result.json();
}

test('all private operations authorize before any storage or upstream access', async t => {
  const bucket = seeded(); let fetched = false; t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('unexpected'); });
  for (const path of [endpoint, manualEndpoint, devEndpoint]) {
    const body = path === endpoint ? undefined : {};
    const anonymous = await handleWritingDashboard(request(path, body, { auth: null }), env(bucket));
    assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('X-Robots-Tag'), 'noindex, nofollow'); assert.match(anonymous.headers.get('Cache-Control'), /no-store/);
    for (const headers of [{ 'oai-authenticated-user-id': 'other-id', 'oai-authenticated-user-email': 'other@example.test' }, { 'oai-authenticated-user-email': 'owner@example.test' }, { 'oai-authenticated-user-id': 'owner-id' }]) {
      assert.equal((await handleWritingDashboard(request(path, body, { auth: null, headers }), env(bucket))).status, 403);
    }
  }
  assert.deepEqual(bucket.calls, []); assert.equal(fetched, false);
  assert.equal((await handleWritingDashboard(request(), env(bucket, { WRITING_OWNER_EMAIL: '' }))).status, 403);
  assert.equal(await handleWritingDashboard(new Request(origin + '/api/articles'), env(bucket)), null);
});

test('both owner identity and independent service bearer can read; wrong methods do not read', async () => {
  const bucket = seeded();
  assert.equal((await handleWritingDashboard(request(endpoint, {}, { method: 'POST' }), env(bucket))).status, 405);
  assert.deepEqual(bucket.calls, []);
  for (const auth of ['owner', 'service']) assert.equal((await handleWritingDashboard(request(endpoint, undefined, { auth }), env(bucket))).status, 200);
});

test('dashboard separates recorded lifetime from 30-day trend and missing external sources', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded(); bucket.pageSize = 1;
  bucket.seed('analytics/2026-09-01.json', { version: 1, day: '2026-09-01', paths: { [`/writing/${first.slug}`]: { pageview: 7 }, '/': { pageview: 999 } } });
  bucket.seed('analytics/2026-11-13.json', { version: 1, day: '2026-11-13', paths: { [`/writing/${first.slug}`]: { pageview: 3 }, [`/writing/${second.slug}`]: { pageview: 2 }, '(other)': { pageview: 4 } } });
  bucket.seed(`article-reactions/v1/articles/${first.slug}.json`, { version: 1, slug: first.slug, count: 2, voters: { ['a'.repeat(64)]: true, ['b'.repeat(64)]: true } });
  assert.equal((await handleWritingDashboard(request(manualEndpoint, imported('devto')), env(bucket))).status, 200);
  assert.equal((await handleWritingDashboard(request(manualEndpoint, imported('substack', first.slug, 50)), env(bucket))).status, 200);
  const result = await handleWritingDashboard(request(), env(bucket)), value = await result.json();
  assert.equal(value.articles[0].websiteViews, 10); assert.equal(value.articles[0].likes, 2); assert.equal(value.articles[0].totalViews, 160);
  assert.equal(value.articles[1].devto, null); assert.equal(value.articles[1].medium, null);
  assert.deepEqual(value.totals, { websiteViews: 12, likes: 2, devtoViews: 100, substackViews: 50, mediumViews: null, reportedViews: 162 });
  assert.equal(value.daily.length, 30); assert.equal(value.daily.reduce((sum, day) => sum + day.views, 0), 5);
  assert.deepEqual(value.articles.map(article => article.periodWebsiteViews), [3, 2]);
  assert.deepEqual(value.period, { range: '30d', from: '2026-10-15', to: '2026-11-13', today: '2026-11-13', timeZone: 'America/Toronto', websiteSince: '2026-09-01', includesUnrecordedDays: false, includesToday: true, totalWebsiteViews: 5, selectedArticle: null, selectedArticleViews: 5, daily: value.daily });
  assert.equal(value.coverage.websiteSince, '2026-09-01'); assert.equal(value.coverage.unassignedWebsiteViews, 4);
  assert.deepEqual(value.coverage.platforms.devto, { reportedArticles: 1, totalArticles: 2, earliestAsOf: asOf, latestAsOf: asOf });
  assert.equal(JSON.stringify(value).includes('voters'), false); assert.equal(JSON.stringify(value).includes('bodyHtml'), false);
});

test('runtime archive supplies newly imported articles; empty analytics has unknown collection start', async () => {
  const bucket = seeded(), fresh = { ...first, id: 123456789, slug: 'new-runtime-article', sourceUrl: 'https://dev.to/dessygil/new-runtime-article' };
  bucket.seed('writing/archive-v1.json', { articles: [fresh] });
  const result = await handleWritingDashboard(request(), env(bucket)), value = await result.json();
  assert.equal(result.status, 200); assert.equal(value.articles[0].slug, fresh.slug); assert.equal(value.coverage.websiteSince, null); assert.equal(value.totals.devtoViews, null);
  const fallbackResult = await (await handleWritingDashboard(request(), env(new Bucket()))).json(); assert.equal(fallbackResult.articles.length, fallback.length);
});

test('rolling and inclusive custom ranges retain per-article counts while selection changes only the chart', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded(); bucket.pageSize = 2;
  seedDay(bucket, '2026-09-01', 100, 200);
  seedDay(bucket, '2026-11-06', 10, 20);
  seedDay(bucket, '2026-11-07', 1, 2);
  seedDay(bucket, '2026-11-09', 0, 0, { '/': { pageview: 999 }, '(other)': { pageview: 10 } });
  seedDay(bucket, '2026-11-10', 3, 5);
  seedDay(bucket, '2026-11-13', 7, 11);
  const baseline = await readDashboard(bucket);
  for (const [range, from, expected, length] of [['7d', '2026-11-07', [11, 18], 7], ['30d', '2026-10-15', [21, 38], 30], ['90d', '2026-08-16', [121, 238], 90], ['all', '2026-09-01', [121, 238], 74]]) {
    const result = await readDashboard(bucket, `?range=${range}`);
    assert.equal(result.period.from, from); assert.equal(result.period.to, '2026-11-13'); assert.equal(result.period.daily.length, length);
    assert.deepEqual(result.articles.map(article => article.periodWebsiteViews), expected);
    assert.equal(result.period.totalWebsiteViews, expected[0] + expected[1]); assert.equal(result.period.selectedArticleViews, result.period.totalWebsiteViews);
    assert.deepEqual(result.totals, baseline.totals); assert.deepEqual(result.daily, baseline.daily);
  }
  const query = '?range=custom&from=2026-11-07&to=2026-11-10', allArticles = await readDashboard(bucket, query);
  bucket.calls = [];
  const selected = await readDashboard(bucket, `${query}&article=${second.slug}`);
  assert.deepEqual(selected.articles.map(article => article.periodWebsiteViews), [4, 7]);
  assert.equal(selected.period.totalWebsiteViews, 11); assert.equal(selected.period.selectedArticleViews, 7); assert.equal(selected.period.selectedArticle, second.slug);
  assert.deepEqual(selected.period.daily, [{ day: '2026-11-07', views: 2 }, { day: '2026-11-08', views: 0 }, { day: '2026-11-09', views: 0 }, { day: '2026-11-10', views: 5 }]);
  assert.deepEqual(selected.articles, allArticles.articles); assert.deepEqual(selected.totals, baseline.totals); assert.deepEqual(selected.daily, baseline.daily); assert.deepEqual(selected.coverage, baseline.coverage);
  assert.equal(selected.period.includesToday, false);
  assert.equal(bucket.calls.filter(([kind, key]) => kind === 'get' && key.startsWith('analytics/')).length, 6, 'selected chart reuses the lifetime scan');
  const single = await readDashboard(bucket, '?range=custom&from=2026-11-13&to=2026-11-13');
  assert.deepEqual(single.period.daily, [{ day: '2026-11-13', views: 18 }]); assert.equal(single.period.includesToday, true);
});

test('period coverage distinguishes precollection, homepage-only start, gaps, and empty history', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded();
  bucket.seed('analytics/2026-11-10.json', { version: 1, day: '2026-11-10', paths: { '/': { pageview: 99 } } });
  seedDay(bucket, '2026-11-12', 4);
  const mixed = await readDashboard(bucket, '?range=custom&from=2026-11-08&to=2026-11-12');
  assert.equal(mixed.period.websiteSince, '2026-11-10'); assert.equal(mixed.period.includesUnrecordedDays, true);
  assert.deepEqual(mixed.period.daily.map(day => day.views), [null, null, 0, 0, 4]); assert.equal(mixed.period.totalWebsiteViews, 4);
  const before = await readDashboard(bucket, '?range=custom&from=2026-11-08&to=2026-11-09');
  assert.deepEqual(before.period.daily.map(day => day.views), [null, null]); assert.equal(before.period.includesUnrecordedDays, true);
  assert.equal(before.period.totalWebsiteViews, 0); assert.equal(before.period.selectedArticleViews, 0); assert.deepEqual(before.articles.map(article => article.periodWebsiteViews), [0, 0]);
  const all = await readDashboard(bucket, '?range=all');
  assert.equal(all.period.from, '2026-11-10'); assert.equal(all.period.includesUnrecordedDays, false); assert.deepEqual(all.period.daily.map(day => day.views), [0, 0, 4, 0]);
  const empty = seeded(), recent = await readDashboard(empty, `?range=7d&article=${first.slug}`);
  assert.equal(recent.period.websiteSince, null); assert.equal(recent.period.includesUnrecordedDays, true); assert.equal(recent.period.selectedArticleViews, 0);
  assert.deepEqual(recent.period.daily.map(day => day.views), Array(7).fill(null)); assert.ok(recent.daily.every(day => day.views === 0), 'legacy summary remains backward compatible');
  const emptyAll = await readDashboard(empty, '?range=all');
  assert.equal(emptyAll.period.from, '2026-11-13'); assert.deepEqual(emptyAll.period.daily, [{ day: '2026-11-13', views: null }]);
});

test('Toronto today is captured once across midnight and UTC dates cannot select future local days', async t => {
  const beforeMidnight = Date.parse('2026-11-14T04:59:59.999Z'), afterMidnight = beforeMidnight + 1;
  let calls = 0; t.mock.method(Date, 'now', () => calls++ === 0 ? beforeMidnight : afterMidnight);
  const bucket = seeded(); seedDay(bucket, '2026-11-13', 2);
  const before = await readDashboard(bucket, '?range=7d');
  assert.equal(calls, 1); assert.equal(before.period.today, '2026-11-13'); assert.equal(before.period.to, '2026-11-13'); assert.equal(before.daily.at(-1).day, '2026-11-13'); assert.equal(before.coverage.generatedAt, '2026-11-14T04:59:59.999Z');
  const after = await readDashboard(bucket, '?range=7d');
  assert.equal(after.period.today, '2026-11-14'); assert.equal(after.period.from, '2026-11-08'); assert.equal(after.period.daily.at(-1).views, 0);
  calls = 0; bucket.calls = [];
  const future = await handleWritingDashboard(request(endpoint + '?range=custom&from=2026-11-14&to=2026-11-14'), env(bucket));
  assert.equal(future.status, 400); assert.deepEqual(bucket.calls, []);
});

test('Toronto spring and fall daylight-saving changes retain every inclusive calendar day', async t => {
  let currentTime = now; t.mock.method(Date, 'now', () => currentTime);
  for (const [instant, dates] of [['2026-03-10T03:30:00Z', ['2026-03-07', '2026-03-08', '2026-03-09']], ['2026-11-03T04:30:00Z', ['2026-10-31', '2026-11-01', '2026-11-02']]]) {
    currentTime = Date.parse(instant); const bucket = seeded();
    dates.forEach((day, index) => seedDay(bucket, day, index + 1));
    const result = await readDashboard(bucket, `?range=custom&from=${dates[0]}&to=${dates[2]}`);
    assert.equal(result.period.today, dates[2]); assert.equal(result.period.includesToday, true);
    assert.deepEqual(result.period.daily, dates.map((day, index) => ({ day, views: index + 1 })));
    assert.equal(result.period.totalWebsiteViews, 6);
    const week = await readDashboard(bucket, '?range=7d'); assert.equal(week.period.daily.length, 7); assert.equal(week.period.daily.at(-1).day, dates[2]);
  }
});

test('private range validation rejects malformed parameters before storage and unknown articles before analytics', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded();
  const invalid = ['?range=', '?range=year', '?range=7d&range=30d', '?range=7d&%72ange=7d', '?unknown=1', '?from=2026-11-01', '?range=all&to=2026-11-13', '?article=', '?article=Bad%20Slug', `?article=${first.slug}&article=${first.slug}`, '?range=custom', '?range=custom&from=2026-11-01', '?range=custom&from=2026-11-13&to=2026-11-12', '?range=custom&from=2026-02-29&to=2026-03-01', '?range=custom&from=2026-13-01&to=2026-13-02', '?range=custom&from=2026-1-01&to=2026-11-13', '?range=custom&from=2026-11-01T00:00:00Z&to=2026-11-13', '?range=custom&from=2026-11-14&to=2026-11-14', '?range=custom&from=2026-11-01&from=2026-11-02&to=2026-11-13', '?range=custom&from=2026-11-01&to=2026-11-13&to=2026-11-13'];
  for (const query of [...invalid, '?article=unknown-article']) {
    assert.equal((await handleWritingDashboard(request(endpoint + query, undefined, { auth: null }), env(bucket))).status, 401);
    assert.equal((await handleWritingDashboard(request(endpoint + query, undefined, { headers: { 'oai-authenticated-user-email': 'other@example.test' } }), env(bucket))).status, 403);
  }
  assert.deepEqual(bucket.calls, []);
  for (const query of invalid) {
    const result = await handleWritingDashboard(request(endpoint + query), env(bucket));
    assert.equal(result.status, 400, query); assert.match(result.headers.get('Cache-Control'), /no-store/); assert.equal(result.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  }
  assert.deepEqual(bucket.calls, []);
  assert.equal((await handleWritingDashboard(request(endpoint + '?article=unknown-article'), env(bucket))).status, 400);
  assert.deepEqual(bucket.calls, [['get', 'writing/archive-v1.json']]);
});

test('custom day limits are inclusive and sparse all-history series cannot allocate unbounded dates', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded(), end = Date.parse('2026-11-13T00:00:00Z');
  const from = offset => new Date(end - offset * 86_400_000).toISOString().slice(0, 10);
  const maximum = await readDashboard(bucket, `?range=custom&from=${from(3659)}&to=2026-11-13`);
  assert.equal(maximum.period.daily.length, 3660);
  bucket.calls = [];
  assert.equal((await handleWritingDashboard(request(`${endpoint}?range=custom&from=${from(3660)}&to=2026-11-13`), env(bucket))).status, 400); assert.deepEqual(bucket.calls, []);
  seedDay(bucket, '2010-01-01', 5);
  const recent = await readDashboard(bucket); assert.equal(recent.totals.websiteViews, 5); assert.equal(recent.period.totalWebsiteViews, 0);
  const unbounded = await handleWritingDashboard(request(endpoint + '?range=all'), env(bucket)); assert.equal(unbounded.status, 503); assert.match((await unbounded.json()).error, /archive rollup/);
});

test('manual imports validate the complete batch, dates, source hosts and integer counts before writing', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded(), base = imported();
  for (const payload of [
    { ...base, asOf: '2026-02-30' }, { ...base, asOf: '2027-01-01' }, { ...base, asOf: '2026-11-12T25:00:00Z' }, { ...base, platform: 'elsewhere' },
    { ...base, articles: [...base.articles, { ...base.articles[0] }] }, { ...base, articles: [...base.articles, { ...base.articles[0], slug: 'unknown' }] },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER, '4'].map(views => ({ ...base, articles: [{ ...base.articles[0], views }] })),
    ...['https://medium.com.evil.test/post', 'https://user:pass@medium.com/post', 'http://medium.com/post', 'https://medium.com:8443/post', 'https://medium.com/', 'https://custom.example/post'].map(url => ({ ...base, articles: [{ ...base.articles[0], url }] })),
  ]) assert.equal((await handleWritingDashboard(request(manualEndpoint, payload), env(bucket))).status, 400);
  assert.equal(writes(bucket).length, 0);
  const valid = { ...base, asOf: '2026-11-12', articles: [{ ...base.articles[0], url: 'https://medium.com/@dessygil/post?tracking=ignored#fragment' }] };
  assert.equal((await handleWritingDashboard(request(manualEndpoint, valid), env(bucket))).status, 200);
  const saved = bucket.value(snapshotKey).platforms.medium[first.slug]; assert.equal(saved.asOf, '2026-11-12T00:00:00.000Z'); assert.equal(saved.url, 'https://medium.com/@dessygil/post');
});

test('mutations require same-origin JSON and reject oversized streaming input before storage', async () => {
  const bucket = seeded();
  for (const auth of ['owner', 'service']) assert.equal((await handleWritingDashboard(request(manualEndpoint, imported(), { auth, headers: { Origin: 'https://other.example' } }), env(bucket))).status, 403);
  assert.equal((await handleWritingDashboard(request(manualEndpoint, imported(), { headers: { 'Content-Type': 'text/plain' } }), env(bucket))).status, 415);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(513 * 1024)); }, cancel() { cancelled = true; } });
  assert.equal((await handleWritingDashboard(request(manualEndpoint, stream, { duplex: 'half' }), env(bucket))).status, 413); assert.equal(cancelled, true); assert.deepEqual(bucket.calls, []);
  const absent = request(manualEndpoint, imported()); absent.headers.delete('Origin'); assert.equal((await handleWritingDashboard(absent, env(bucket))).status, 403);
  const service = request(manualEndpoint, imported(), { auth: 'service' }); service.headers.delete('Origin'); assert.equal((await handleWritingDashboard(service, env(bucket))).status, 200);
});

test('CAS preserves concurrent source imports and rejects stale per-article snapshots', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded();
  const responses = await Promise.all(['medium', 'substack'].map(platform => handleWritingDashboard(request(manualEndpoint, imported(platform)), env(bucket))));
  assert.deepEqual(responses.map(value => value.status), [200, 200]);
  assert.equal(bucket.value(snapshotKey).platforms.medium[first.slug].views, 100); assert.equal(bucket.value(snapshotKey).platforms.substack[first.slug].views, 100);
  const before = bucket.objects.get(snapshotKey).text;
  assert.equal((await handleWritingDashboard(request(manualEndpoint, imported('medium', first.slug, 999, '2026-11-01')), env(bucket))).status, 409);
  assert.equal(bucket.objects.get(snapshotKey).text, before);
  const busy = seeded(); busy.conflicts = 10; assert.equal((await handleWritingDashboard(request(manualEndpoint, imported()), env(busy))).status, 503); assert.equal(writes(busy).length, 4); assert.equal(busy.objects.has(snapshotKey), false);
});

test('one external story cannot inflate totals through duplicate local mappings', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const platform of ['medium', 'substack']) {
    const bucket = seeded(), base = imported(platform), original = base.articles[0];
    const duplicate = { ...original, slug: second.slug, url: `${original.url}/?tracking=ignored#section` };
    const batch = await handleWritingDashboard(request(manualEndpoint, { ...base, articles: [original, duplicate] }), env(bucket));
    assert.equal(batch.status, 409); assert.equal(writes(bucket).length, 0);
    assert.equal((await handleWritingDashboard(request(manualEndpoint, base), env(bucket))).status, 200);
    const before = bucket.objects.get(snapshotKey).text, writeCount = writes(bucket).length;
    const existingCollision = await handleWritingDashboard(request(manualEndpoint, { ...base, articles: [duplicate] }), env(bucket));
    assert.equal(existingCollision.status, 409); assert.equal(writes(bucket).length, writeCount); assert.equal(bucket.objects.get(snapshotKey).text, before);
    const dashboard = await (await handleWritingDashboard(request(), env(bucket))).json(); assert.equal(dashboard.totals[`${platform}Views`], 100);
  }
});

test('DEV.to verifies owner and paginates before atomically saving only matched counters, never the key', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = seeded(), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    // Workerd rejects redirect:error before network I/O; Node fetch accepts it.
    if (!['follow', 'manual'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
    calls.push({ url, options });
    return response(url.endsWith('/users/me') ? { username: 'dessygil' } : url.endsWith('page=1') ? largePage() : [remoteArticle(second)]);
  });
  const result = await handleWritingDashboard(request(devEndpoint, { apiKey: secret }), env(bucket)), value = await result.json();
  assert.equal(result.status, 200); assert.equal(value.imported, 2); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.url), ['https://dev.to/api/users/me', 'https://dev.to/api/articles/me/published?per_page=100&page=1', 'https://dev.to/api/articles/me/published?per_page=100&page=2']);
  assert.ok(calls.every(({ options }) => options.redirect === 'manual' && options.headers['api-key'] === secret && options.signal instanceof AbortSignal));
  assert.ok(calls.every(({ options }) => options.headers['User-Agent'].startsWith('DesPersonalSite/')));
  assert.equal(writes(bucket).length, 1); assert.equal(bucket.value(snapshotKey).platforms.devto[first.slug].views, 42);
  assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(JSON.stringify([...bucket.objects]).includes(secret), false);
});

test('DEV.to redirects never receive credentials and upstream failures preserve useful error codes', async t => {
  for (const [status, expectedStatus, code] of [[301, 502, 'devto_unavailable'], [302, 502, 'devto_unavailable'], [307, 502, 'devto_unavailable'], [308, 502, 'devto_unavailable'], [401, 400, 'devto_invalid_key'], [403, 502, 'devto_blocked'], [429, 429, 'devto_rate_limited'], [503, 502, 'devto_unavailable']]) {
    const bucket = seeded(); let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls += 1; assert.equal(url, 'https://dev.to/api/users/me'); assert.equal(options.redirect, 'manual');
      return new Response(`Untrusted upstream body ${secret}`, { status, headers: { Location: 'https://other.example/steal-key' } });
    });
    const result = await handleWritingDashboard(request(devEndpoint, { apiKey: secret }), env(bucket));
    const value = await result.json(); assert.equal(result.status, expectedStatus); assert.equal(value.code, code);
    assert.equal(calls, 1); assert.equal(writes(bucket).length, 0); assert.equal(JSON.stringify(value).includes(secret), false);
  }
});

test('DEV.to transport and unreadable responses are distinguished from an invalid key', async t => {
  for (const [kind, code] of [['network', 'devto_connection_failed'], ['html', 'devto_invalid_response']]) {
    const bucket = seeded();
    t.mock.method(globalThis, 'fetch', async () => { if (kind === 'network') throw new TypeError('fetch failed'); return new Response('<html>Upstream unavailable</html>'); });
    const result = await handleWritingDashboard(request(devEndpoint, { apiKey: secret }), env(bucket));
    const value = await result.json(); assert.equal(result.status, 502); assert.equal(value.code, code); assert.equal(writes(bucket).length, 0);
  }
});

test('wrong DEV.to account and invalid later pages leave saved snapshots intact', async t => {
  const bucket = seeded(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response({ username: 'different-account' }); });
  const wrongAccount = await handleWritingDashboard(request(devEndpoint, { apiKey: secret }), env(bucket));
  assert.equal(wrongAccount.status, 400); assert.equal((await wrongAccount.json()).code, 'devto_account_mismatch'); assert.equal(calls, 1); assert.equal(writes(bucket).length, 0);
  t.mock.method(globalThis, 'fetch', async url => response(url.endsWith('/users/me') ? { username: 'dessygil' } : url.endsWith('page=1') ? largePage() : [{ ...remoteArticle(second), page_views_count: null }]));
  assert.equal((await handleWritingDashboard(request(devEndpoint, { apiKey: secret }), env(bucket))).status, 502); assert.equal(writes(bucket).length, 0);
});

test('missing keys are setup state; invalid header keys never fetch; runtime key is supported', async t => {
  const bucket = seeded(); let fetched = 0;
  t.mock.method(globalThis, 'fetch', async url => { fetched += 1; return response(url.endsWith('/users/me') ? { username: 'dessygil' } : [remoteArticle(first)]); });
  const missing = await handleWritingDashboard(request(devEndpoint, {}), env(bucket)); assert.equal(missing.status, 409); assert.equal((await missing.json()).code, 'devto_key_required');
  for (const apiKey of ['bad\r\nheader', 'a'.repeat(257), 123, null]) assert.equal((await handleWritingDashboard(request(devEndpoint, { apiKey }), env(bucket))).status, 400);
  assert.equal(fetched, 0); assert.equal((await handleWritingDashboard(request(devEndpoint, {}), env(bucket, { DEVTO_ANALYTICS_API_KEY: secret }))).status, 200); assert.equal(fetched, 2);
});

test('upstream and storage failures expose no credentials and never fake missing data as zero', async t => {
  const bucket = seeded(); t.mock.method(globalThis, 'fetch', async () => { throw new Error(`upstream leaked ${secret}`); });
  const upstream = await handleWritingDashboard(request(devEndpoint, { apiKey: secret }), env(bucket)); assert.equal(upstream.status, 502); assert.equal((await upstream.text()).includes(secret), false);
  bucket.seed(snapshotKey, { version: 1, updatedAt: asOf, platforms: { medium: { [first.slug]: { views: -1, url: 'https://medium.com/post', asOf } } } });
  assert.equal((await handleWritingDashboard(request(), env(bucket))).status, 503);
  bucket.objects.delete(snapshotKey); bucket.seed('analytics/2026-11-01.json', { version: 1, day: '2026-11-01', paths: { [`/writing/${first.slug}`]: { pageview: -1 } } });
  assert.equal((await handleWritingDashboard(request(), env(bucket))).status, 503);
});

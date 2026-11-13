import test from 'node:test';
import assert from 'node:assert/strict';
import { handleArticleReactions, readReactionTotals } from '../server/articleReactions.mjs';
import articles from '../client/src/data/article-index.json' with { type: 'json' };

const origin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
const slug = articles[0].slug, secondSlug = articles[1].slug;
const visitorA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const visitorB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const visitorC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now = Date.parse('2026-11-13T16:20:00.000Z');
const verifier = 'a'.repeat(64);
const rateKey = 'article-reactions/v1/rate.json';
const articleKey = name => `article-reactions/v1/articles/${name}.json`;
class Bucket {
  constructor() { this.objects = new Map(); this.calls = []; this.revision = 0; this.conflicts = new Map(); }
  seed(key, value) { this.objects.set(key, { text: JSON.stringify(value), etag: String(++this.revision) }); }
  value(key) { return JSON.parse(this.objects.get(key).text); }
  async get(key) {
    this.calls.push(['get', key]); const item = this.objects.get(key);
    return item ? { etag: item.etag, size: new TextEncoder().encode(item.text).length, json: async () => JSON.parse(item.text) } : null;
  }
  async put(key, text, options = {}) {
    this.calls.push(['put', key, options]);
    const conflicts = this.conflicts.get(key) || 0;
    if (conflicts) { this.conflicts.set(key, conflicts - 1); return null; }
    const current = this.objects.get(key), condition = options.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && current) return null;
    if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
    const item = { text, etag: String(++this.revision) }; this.objects.set(key, item); return { key, etag: item.etag };
  }
}
const env = (BUCKET = new Bucket(), extra = {}) => ({ BUCKET, REACTION_HMAC_SECRET: verifier, ...extra });
function request(name = slug, options = {}) {
  const { visitor, liked, body, headers: edits = {}, site = origin, query, ...rest } = options;
  const posting = liked !== undefined || body !== undefined || rest.method === 'POST';
  const headers = new Headers(posting ? { Origin: site, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.15' } : {});
  for (const [key, value] of Object.entries(edits)) { if (value === null) headers.delete(key); else headers.set(key, value); }
  const search = query !== undefined ? query : !posting && visitor !== undefined ? `?visitor=${encodeURIComponent(visitor)}` : '';
  const content = posting ? body !== undefined ? body : JSON.stringify({ visitor, liked }) : undefined;
  return new Request(`${site}/api/article-reactions/${name}${search}`, { method: posting ? 'POST' : 'GET', headers, body: content, ...rest });
}
const vote = (visitor = visitorA, liked = true, options = {}) => request(slug, { visitor, liked, ...options });
const read = async (bucket, visitor = visitorA, name = slug) => (await handleArticleReactions(request(name, { visitor }), env(bucket))).json();

test('unrelated routes are left alone; invalid endpoint paths and methods touch no storage', async () => {
  const bucket = new Bucket();
  assert.equal(await handleArticleReactions(new Request(`${origin}/writing`), env(bucket)), null);
  for (const name of ['', 'one/two', '%2e%2e%2fprivate', 'x'.repeat(201), 'MixedCase']) assert.equal((await handleArticleReactions(request(name), env(bucket))).status, 404);
  const invalidMethod = await handleArticleReactions(request(slug, { method: 'DELETE' }), env(bucket));
  assert.equal(invalidMethod.status, 405); assert.equal(invalidMethod.headers.get('Allow'), 'GET, POST');
  assert.deepEqual(bucket.calls, []);
});
test('anonymous browser can read, like, retry and undo exactly once', async () => {
  const bucket = new Bucket();
  const empty = await handleArticleReactions(request(), env(bucket));
  assert.deepEqual(await empty.json(), { count: 0, liked: false }); assert.equal(empty.headers.get('Cache-Control'), 'no-store');
  let result = await handleArticleReactions(vote(), env(bucket)); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { count: 1, liked: true });
  assert.deepEqual(await read(bucket, visitorA.toUpperCase()), { count: 1, liked: true });
  assert.deepEqual(await read(bucket, visitorB), { count: 1, liked: false });
  const writes = bucket.calls.filter(call => call[0] === 'put').length;
  result = await handleArticleReactions(vote(), env(bucket)); assert.deepEqual(await result.json(), { count: 1, liked: true });
  assert.equal(bucket.calls.filter(call => call[0] === 'put').length, writes);
  result = await handleArticleReactions(vote(visitorA, false), env(bucket)); assert.deepEqual(await result.json(), { count: 0, liked: false });
  result = await handleArticleReactions(vote(visitorA, false), env(bucket)); assert.deepEqual(await result.json(), { count: 0, liked: false });
  assert.equal(bucket.value(articleKey(slug)).count, 0); assert.deepEqual(bucket.value(articleKey(slug)).voters, {});
});
test('voters are hashed per article; tokens, IPs, cookies and user agents are not stored', async () => {
  const bucket = new Bucket();
  assert.equal((await handleArticleReactions(vote(visitorA, true, { headers: { Cookie: 'private-cookie', 'User-Agent': 'private-user-agent' } }), env(bucket))).status, 200);
  assert.equal((await handleArticleReactions(request(secondSlug, { visitor: visitorA, liked: true }), env(bucket))).status, 200);
  const firstHash = Object.keys(bucket.value(articleKey(slug)).voters)[0], secondHash = Object.keys(bucket.value(articleKey(secondSlug)).voters)[0];
  assert.match(firstHash, /^[a-f0-9]{64}$/); assert.notEqual(firstHash, secondHash);
  const stored = JSON.stringify([...bucket.objects.values()]);
  for (const value of [visitorA, '192.0.2.15', 'private-cookie', 'private-user-agent']) assert.equal(stored.includes(value), false);
});
test('only known fallback or saved archive articles can receive reactions', async () => {
  const bucket = new Bucket();
  assert.equal((await handleArticleReactions(request('unknown-article'), env(bucket))).status, 404);
  assert.deepEqual(bucket.calls, [['get', 'writing/archive-v1.json']]);
  bucket.seed('writing/archive-v1.json', { articles: [{ slug: 'new-runtime-article' }] });
  const result = await handleArticleReactions(request('new-runtime-article', { visitor: visitorA, liked: true }), env(bucket));
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { count: 1, liked: true });
});

test('POST origin must match exactly, before reading any storage', async () => {
  const bucket = new Bucket();
  for (const value of [null, 'null', 'https://evil.example', `${origin}.evil.example`, origin.replace('https:', 'http:')]) {
    const result = await handleArticleReactions(vote(visitorA, true, { headers: { Origin: value } }), env(bucket));
    assert.equal(result.status, 403);
  }
  assert.deepEqual(bucket.calls, []);
  for (const site of [origin, 'https://desmondgilmour.com']) assert.equal((await handleArticleReactions(vote(visitorA, true, { site }), env(new Bucket()))).status, 200);
});
test('malformed bodies, tokens, unexpected fields and query inputs cannot mutate storage', async () => {
  const bucket = new Bucket();
  for (const body of ['{', 'null', '[]', JSON.stringify({ visitor: visitorA, liked: 'true' }), JSON.stringify({ visitor: visitorA, liked: true, count: 100 }), JSON.stringify({ visitor: 'not-a-token', liked: true }), JSON.stringify({ visitor: visitorA.replace('-4aaa-', '-1aaa-'), liked: true }), JSON.stringify({ liked: true }), JSON.stringify({ visitor: visitorA })]) {
    assert.equal((await handleArticleReactions(request(slug, { body }), env(bucket))).status, 400);
  }
  assert.equal((await handleArticleReactions(vote(visitorA, true, { headers: { 'Content-Type': 'text/plain' } }), env(bucket))).status, 415);
  assert.equal((await handleArticleReactions(vote(visitorA, true, { query: '?count=100' }), env(bucket))).status, 400);
  for (const query of ['?visitor=', `?visitor=${visitorA}&visitor=${visitorA}`, '?count=10', '?visitor=../secret']) assert.equal((await handleArticleReactions(request(slug, { query }), env(bucket))).status, 400);
  assert.deepEqual(bucket.calls, []);
});
test('body cap applies to headers and streaming bytes, including invalid UTF-8', async () => {
  const bucket = new Bucket();
  assert.equal((await handleArticleReactions(vote(visitorA, true, { headers: { 'Content-Length': '1025' } }), env(bucket))).status, 413);
  assert.equal((await handleArticleReactions(vote(visitorA, true, { headers: { 'Content-Length': '-1' } }), env(bucket))).status, 413);
  assert.equal((await handleArticleReactions(request(slug, { body: ' '.repeat(1025) }), env(bucket))).status, 413);
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { canceled = true; } });
  assert.equal((await handleArticleReactions(request(slug, { body: stream, duplex: 'half' }), env(bucket))).status, 413);
  assert.equal(canceled, true);
  assert.equal((await handleArticleReactions(request(slug, { body: new Uint8Array([0xc0, 0xaf]) }), env(bucket))).status, 400);
  assert.deepEqual(bucket.calls, []);
});
test('missing server pepper or trusted IP fails closed; forwarded headers cannot substitute', async () => {
  const bucket = new Bucket();
  assert.equal((await handleArticleReactions(vote(), env(bucket, { REACTION_HMAC_SECRET: undefined }))).status, 503);
  assert.equal((await handleArticleReactions(request(slug), env(bucket, { REACTION_HMAC_SECRET: undefined }))).status, 200);
  for (const ip of [null, '', '192.0.2.999', '192.0.2.15, 192.0.2.16', '012.0.0.1', 'bad:ipv6']) {
    assert.equal((await handleArticleReactions(vote(visitorA, true, { headers: { 'CF-Connecting-IP': ip, 'X-Forwarded-For': '192.0.2.15' } }), env(bucket))).status, 503);
  }
  assert.equal(bucket.calls.some(call => call[0] === 'put'), false);
  assert.equal((await handleArticleReactions(vote(visitorA, true, { headers: { 'CF-Connecting-IP': '2001:db8::15' } }), env(bucket))).status, 200);
});
test('concurrent likes by one browser count once, and different browsers are not lost', async () => {
  const bucket = new Bucket();
  const same = await Promise.all([handleArticleReactions(vote(), env(bucket)), handleArticleReactions(vote(), env(bucket))]);
  assert.deepEqual(same.map(result => result.status), [200, 200]);
  assert.deepEqual(await read(bucket), { count: 1, liked: true });
  const different = await Promise.all([handleArticleReactions(vote(visitorB), env(bucket)), handleArticleReactions(vote(visitorC), env(bucket))]);
  assert.deepEqual(different.map(result => result.status), [200, 200]);
  assert.deepEqual(await read(bucket, visitorC), { count: 3, liked: true });
  const change = await Promise.all([handleArticleReactions(vote(visitorA, false), env(bucket)), handleArticleReactions(vote(visitorB, false), env(bucket))]);
  assert.deepEqual(change.map(result => result.status), [200, 200]);
  assert.deepEqual(await read(bucket, visitorC), { count: 1, liked: true });
  const state = bucket.value(articleKey(slug));
  assert.equal(state.count, Object.keys(state.voters).length);
  assert.equal(bucket.calls.filter(call => call[0] === 'put').every(call => Object.keys(call[2].onlyIf).length === 1), true);
});
test('conditional conflicts retry within a bound and never report an uncommitted vote', async () => {
  const bucket = new Bucket(); bucket.conflicts.set(articleKey(slug), 2);
  assert.equal((await handleArticleReactions(vote(), env(bucket))).status, 200);
  assert.equal(bucket.value(articleKey(slug)).count, 1);
  bucket.conflicts.set(articleKey(slug), 10);
  const before = bucket.calls.length;
  const unavailable = await handleArticleReactions(vote(visitorB), env(bucket));
  assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('Retry-After'), '5');
  assert.equal(bucket.calls.slice(before).filter(call => call[0] === 'put' && call[1] === articleKey(slug)).length, 4);
  assert.deepEqual(await read(bucket, visitorB), { count: 1, liked: false });
  const rateBlocked = new Bucket(); rateBlocked.conflicts.set(rateKey, 10);
  assert.equal((await handleArticleReactions(vote(), env(rateBlocked))).status, 503);
  assert.equal(rateBlocked.objects.has(articleKey(slug)), false);
  assert.equal(rateBlocked.calls.filter(call => call[0] === 'put').length, 4);
});
test('storage failures and malformed state fail closed without revealing storage details', async () => {
  for (const brokenKey of [rateKey, articleKey(slug)]) {
    const bucket = new Bucket(), put = bucket.put.bind(bucket);
    bucket.put = async (key, ...args) => { if (key === brokenKey) throw new Error('secret-store-value'); return put(key, ...args); };
    const result = await handleArticleReactions(vote(), env(bucket));
    assert.equal(result.status, 503); assert.equal((await result.text()).includes('secret-store-value'), false);
    assert.equal(bucket.objects.has(articleKey(slug)), false);
  }
  const throwing = new Bucket(); throwing.get = async () => { throw new Error('secret-store-value'); };
  assert.equal((await handleArticleReactions(request(slug), env(throwing))).status, 503);
  for (const state of [{ version: 1, slug, count: 1, voters: {} }, { version: 1, slug, count: -1, voters: {} }, { version: 1, slug, count: 1, voters: { 'raw-token': true } }]) {
    const bucket = new Bucket(); bucket.seed(articleKey(slug), state);
    assert.equal((await handleArticleReactions(vote(), env(bucket))).status, 503);
    assert.equal(bucket.calls.some(call => call[0] === 'put'), false);
  }
  assert.equal((await handleArticleReactions(vote(), {})).status, 503);
});
test('each trusted IP is limited to 60 state changes per hour with expiry and idempotent retries', async t => {
  t.mock.method(Date, 'now', () => now);
  const bucket = new Bucket();
  for (let index = 0; index < 60; index += 1) assert.equal((await handleArticleReactions(vote(visitorA, index % 2 === 0), env(bucket))).status, 200);
  assert.equal(bucket.value(rateKey).count, 60);
  assert.equal((await handleArticleReactions(vote(visitorA, false), env(bucket))).status, 200);
  const limited = await handleArticleReactions(vote(visitorB), env(bucket));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '2400');
  assert.deepEqual(await read(bucket, visitorB), { count: 0, liked: false });
  const priorHash = Object.keys(bucket.value(rateKey).ips)[0];
  Date.now.mock.mockImplementation(() => now + 3_600_000);
  assert.equal((await handleArticleReactions(vote(visitorB), env(bucket))).status, 200);
  assert.equal(bucket.value(rateKey).count, 1); assert.equal(Object.hasOwn(bucket.value(rateKey).ips, priorHash), false);
});
test('global cap cannot be bypassed by a new IP or browser', async t => {
  t.mock.method(Date, 'now', () => now);
  const bucket = new Bucket(), window = Math.floor(now / 3_600_000) * 3_600_000;
  const ips = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [index.toString(16).padStart(64, '0'), 1]));
  bucket.seed(rateKey, { version: 1, window, expiresAt: window + 3_600_000, count: 2000, ips });
  assert.equal((await handleArticleReactions(vote(), env(bucket))).status, 429);
  assert.equal(bucket.objects.has(articleKey(slug)), false);
});
test('dashboard helper returns only counts, deduplicates slugs and propagates storage failures', async () => {
  const bucket = new Bucket(); await handleArticleReactions(vote(), env(bucket));
  const before = bucket.calls.length;
  assert.deepEqual(await readReactionTotals(env(bucket), [slug, secondSlug, slug]), { [slug]: 1, [secondSlug]: 0 });
  assert.equal(bucket.calls.slice(before).length, 2);
  assert.deepEqual(await readReactionTotals({}, []), {});
  for (const invalid of ['not-an-array', ['../private'], Array(1001).fill(slug)]) await assert.rejects(readReactionTotals(env(bucket), invalid), /valid article slugs/);
  await assert.rejects(readReactionTotals(env(bucket), ['unknown-article']), /Article not found/);
  const broken = new Bucket(); broken.get = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(readReactionTotals(env(broken), [slug]), /storage unavailable/);
});
test('public responses are uncached, expose no cross-origin allowance or cookies', async () => {
  const result = await handleArticleReactions(request(slug), env());
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(result.headers.has('Access-Control-Allow-Origin'), false);
  assert.equal(result.headers.has('Set-Cookie'), false);
});

test('rotating the owner service token preserves an existing browser vote', async () => {
  const bucket = new Bucket();
  const first = env(bucket, { WRITING_SERVICE_TOKEN_SHA256: '1'.repeat(64) });
  const rotated = env(bucket, { WRITING_SERVICE_TOKEN_SHA256: '2'.repeat(64) });
  assert.equal((await handleArticleReactions(vote(), first)).status, 200);
  const result = await handleArticleReactions(request(slug, { visitor: visitorA }), rotated);
  assert.deepEqual(await result.json(), { count: 1, liked: true });
  assert.equal((await handleArticleReactions(vote(visitorA, false), rotated)).status, 200);
  assert.equal(bucket.value(articleKey(slug)).count, 0);
});
test('a thrown precondition failure retries; missing ETags cannot overwrite existing votes', async () => {
  const bucket = new Bucket(), put = bucket.put.bind(bucket);
  let failed = false;
  bucket.put = async (key, ...args) => {
    if (key === articleKey(slug) && !failed) { failed = true; throw Object.assign(new Error('conditional conflict'), { status: 412 }); }
    return put(key, ...args);
  };
  assert.equal((await handleArticleReactions(vote(), env(bucket))).status, 200);
  const get = bucket.get.bind(bucket);
  bucket.get = async key => { const object = await get(key); if (key === articleKey(slug) && object) delete object.etag; return object; };
  assert.equal((await handleArticleReactions(vote(visitorB), env(bucket))).status, 503);
  assert.equal(bucket.value(articleKey(slug)).count, 1);
});
test('article storage remains bounded at 10,000 votes and undo is still available', async () => {
  const bucket = new Bucket(); await handleArticleReactions(vote(), env(bucket));
  const state = bucket.value(articleKey(slug));
  for (let index = 0; index < 9999; index += 1) state.voters[index.toString(16).padStart(64, '0')] = true;
  state.count = 10_000; bucket.seed(articleKey(slug), state);
  assert.equal((await handleArticleReactions(vote(visitorB), env(bucket))).status, 503);
  assert.equal(bucket.value(articleKey(slug)).count, 10_000);
  const result = await handleArticleReactions(vote(visitorA, false), env(bucket));
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { count: 9999, liked: false });
});
test('dashboard helper bounds concurrent reads for a complete archive', async () => {
  const bucket = new Bucket(), get = bucket.get.bind(bucket);
  let active = 0, maximum = 0;
  bucket.get = async key => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    try { return await get(key); } finally { active -= 1; }
  };
  const names = articles.map(article => article.slug);
  const result = await readReactionTotals(env(bucket), names);
  assert.equal(Object.keys(result).length, names.length); assert.equal(maximum, 5);
});

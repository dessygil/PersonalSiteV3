import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEngagement } from '../server/engagement.mjs';
import articles from '../client/src/data/article-index.json' with { type: 'json' };
const origin = 'https://desmondgilmour.com', rateKey = 'contact/rate/limits.json';
const token = 'test-only-engagement-writer.not-a-real-secret';
const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), x => x.toString(16).padStart(2, '0')).join('');
const now = Date.parse('2026-11-11T16:20:00.000Z');
const fields = { name: 'Test Visitor', email: 'visitor@example.test', message: 'A test contact message.', _gotcha: '' };
class Bucket {
  constructor() { this.objects = new Map(); this.calls = []; this.revision = 0; this.conflicts = 0; }
  seed(key, value) { this.objects.set(key, { text: JSON.stringify(value), etag: String(++this.revision) }); }
  value(key) { return JSON.parse(this.objects.get(key).text); }
  async get(key) { this.calls.push(['get', key]); const item = this.objects.get(key); return item ? { etag: item.etag, size: new TextEncoder().encode(item.text).length, json: async () => JSON.parse(item.text) } : null; }
  async put(key, text, options = {}) {
    this.calls.push(['put', key, options]);
    if (this.conflicts > 0) { this.conflicts -= 1; return null; }
    const current = this.objects.get(key), condition = options.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && current) return null;
    if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
    const item = { text, etag: String(++this.revision) }; this.objects.set(key, item); return { key, etag: item.etag };
  }
  async list(options) { this.calls.push(['list', options]); const keys = [...this.objects.keys()].filter(k => k.startsWith(options.prefix)).sort(), offset = Number(options.cursor || 0), end = offset + options.limit; return { objects: keys.slice(offset, end).map(key => ({ key })), truncated: keys.length > end, cursor: keys.length > end ? String(end) : undefined }; }
  async delete(key) { this.calls.push(['delete', key]); this.objects.delete(key); }
}
const env = (BUCKET = new Bucket(), extra = {}) => ({ BUCKET, CONTACT_MODE: 'inbox', ANALYTICS_ENABLED: 'true', WRITING_SERVICE_TOKEN_SHA256: verifier, ...extra });
function post(path, body, options = {}) {
  const { site = origin, headers: changes = {}, type = 'application/json', ...rest } = options;
  const headers = new Headers({ Origin: site, 'Content-Type': type, 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'test-private-agent', Cookie: 'test-private-cookie=secret' });
  for (const [key, value] of Object.entries(changes)) { if (value === null) headers.delete(key); else headers.set(key, value); }
  return new Request(`${site}${path}`, { method: 'POST', headers, body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body), ...rest });
}
const contact = (value = fields, options = {}) => post('/api/contact', value, options);
const event = (value = {}, options = {}) => post('/api/analytics', { event: 'pageview', path: '/', referrer: null, ...value }, options);
const privateRequest = (path, options = {}) => new Request(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` }, ...options });
const messages = bucket => [...bucket.objects].filter(([key]) => key.startsWith('contact/messages/')).map(([, value]) => JSON.parse(value.text));
test('unrelated routes and disabled features do not touch storage', async () => {
  const bucket = new Bucket();
  assert.equal(await handleEngagement(new Request(`${origin}/writing`), env(bucket)), null);
  assert.equal((await handleEngagement(contact(), env(bucket, { CONTACT_MODE: 'draft' }))).status, 503);
  assert.equal((await handleEngagement(event(), env(bucket, { ANALYTICS_ENABLED: 'false' }))).status, 204);
  assert.equal((await handleEngagement(event({}, { site: 'https://private-preview.example', headers: { Origin: origin } }), env(bucket))).status, 204);
  assert.deepEqual(bucket.calls, []);
});
test('every private endpoint authorizes before any bucket access', async () => {
  const bucket = new Bucket();
  for (const path of ['/api/private/messages', '/api/private/analytics', '/api/private/messages/0000000000000-00000000-0000-0000-0000-000000000000']) {
    const result = await handleEngagement(new Request(`${origin}${path}`, { headers: { 'X-Des-Sync': 'devto-v1', Authorization: 'Bearer wrong-token' } }), env(bucket));
    assert.equal(result.status, 401);
  }
  assert.equal((await handleEngagement(privateRequest('/api/private/messages', { method: 'POST' }), env(bucket))).status, 405);
  assert.deepEqual(bucket.calls, []);
});
test('contact confirms private durable storage without retaining identity headers', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  const result = await handleEngagement(contact({ ...fields, name: '  Test Visitor  ' }), env(bucket));
  assert.equal(result.status, 202); assert.deepEqual(await result.json(), { ok: true });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const [saved] = messages(bucket); assert.equal(saved.name, fields.name); assert.equal(saved.receivedAt, new Date(now).toISOString());
  assert.match(saved.id, /^\d{13}-[a-f0-9-]{36}$/); assert.equal(saved.email, fields.email);
  const rate = bucket.value(rateKey); assert.equal(rate.count, 1); assert.equal(Object.keys(rate.hourly).length, 1);
  const serialized = JSON.stringify([...bucket.objects.values()]);
  for (const forbidden of ['192.0.2.1', 'test-private-agent', 'test-private-cookie', '_gotcha']) assert.equal(serialized.includes(forbidden), false);
});
test('native form gets an accessible receipt without reflected input', async () => {
  const bucket = new Bucket(), value = { ...fields, name: '<script>name</script>', message: '<img src=x onerror=alert(1)>' };
  const response = await handleEngagement(contact(new URLSearchParams(value).toString(), { type: 'application/x-www-form-urlencoded' }), env(bucket));
  assert.equal(response.status, 202); assert.match(response.headers.get('Content-Type'), /text\/html/);
  const html = await response.text(); assert.match(html, /<main><h1>Message received<\/h1>/); assert.match(html, /href="\/"/);
  assert.equal(html.includes(value.name), false); assert.equal(html.includes(value.message), false); assert.equal(messages(bucket)[0].message, value.message);
});
test('invalid fields, honeypots and duplicate form keys are rejected without storage', async () => {
  const bucket = new Bucket();
  const invalid = [null, [], {}, { ...fields, name: '' }, { ...fields, name: 'x'.repeat(101) }, { ...fields, name: 'one\ntwo' }, { ...fields, email: 'one@example.test\r\nBcc: x' }, { ...fields, email: 'invalid' }, { ...fields, message: 'x'.repeat(5001) }, { ...fields, message: '\u0000' }, { ...fields, _gotcha: 'bot' }, { ...fields, _gotcha: 0 }, { ...fields, extra: 'unused' }];
  for (const value of invalid) assert.equal((await handleEngagement(contact(JSON.stringify(value)), env(bucket))).status, 400);
  assert.equal((await handleEngagement(contact('name=a&name=b&email=a%40b.test&message=hello', { type: 'application/x-www-form-urlencoded' }), env(bucket))).status, 400);
  assert.equal((await handleEngagement(contact('{bad'), env(bucket))).status, 400);
  assert.equal((await handleEngagement(contact('hello', { type: 'text/plain' }), env(bucket))).status, 415);
  for (const value of [null, 'https://other.example', 'null']) assert.equal((await handleEngagement(contact(fields, { headers: { Origin: value } }), env(bucket))).status, 403);
  assert.deepEqual(bucket.calls, []);
});
test('32KiB stream cap accepts UI Unicode text and rejects oversized input', async () => {
  const bucket = new Bucket();
  assert.equal((await handleEngagement(contact({ ...fields, message: '漢'.repeat(5000) }), env(bucket))).status, 202);
  const calls = bucket.calls.length;
  assert.equal((await handleEngagement(contact(fields, { headers: { 'Content-Length': '999999' } }), env(bucket))).status, 413);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33 * 1024)); }, cancel() { cancelled = true; } });
  assert.equal((await handleEngagement(contact(stream, { duplex: 'half' }), env(bucket))).status, 413); assert.equal(cancelled, true);
  assert.equal(bucket.calls.length, calls);
});
test('missing trusted IP or pepper fails closed without trusting forwarded IPs', async () => {
  const bucket = new Bucket();
  assert.equal((await handleEngagement(contact(fields, { headers: { 'CF-Connecting-IP': null, 'X-Forwarded-For': '192.0.2.9' } }), env(bucket))).status, 503);
  assert.equal((await handleEngagement(contact(), env(bucket, { WRITING_SERVICE_TOKEN_SHA256: '' }))).status, 503);
  assert.deepEqual(bucket.calls, []);
});
test('storage failures never claim success or reveal storage error text', async () => {
  for (const failure of ['read', 'message', 'null']) {
    const bucket = new Bucket(), originalPut = bucket.put.bind(bucket);
    if (failure === 'read') bucket.get = async () => { throw null; };
    else bucket.put = async (...args) => { if (args[0].startsWith('contact/messages/')) { if (failure === 'null') return null; throw new Error('sensitive-internal-error'); } return originalPut(...args); };
    const response = await handleEngagement(contact(), env(bucket)); assert.equal(response.status, 503);
    const text = await response.text(); assert.equal(text.includes('sensitive-internal-error'), false); assert.equal(text.includes('"ok":true'), false); assert.equal(messages(bucket).length, 0);
  }
});
test('per-IP quota is five per hour and expired hashes are pruned', async t => {
  let time = now; t.mock.method(Date, 'now', () => time); const bucket = new Bucket();
  for (let i = 0; i < 5; i += 1) assert.equal((await handleEngagement(contact(), env(bucket))).status, 202);
  const blocked = await handleEngagement(contact(fields, { headers: { 'X-Forwarded-For': '192.0.2.222' } }), env(bucket));
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('Retry-After')) > 0); assert.equal(bucket.value(rateKey).count, 5);
  const oldHash = Object.keys(bucket.value(rateKey).hourly)[0]; time += 3_600_000;
  assert.equal((await handleEngagement(contact(), env(bucket))).status, 202);
  const rate = bucket.value(rateKey); assert.equal(rate.count, 6); assert.equal(Object.keys(rate.hourly).length, 1); assert.equal(Object.hasOwn(rate.hourly, oldHash), false);
});
test('global quota caps all senders at 100 submissions per Toronto day', async t => {
  let time = now; t.mock.method(Date, 'now', () => time); const bucket = new Bucket();
  for (let i = 1; i <= 100; i += 1) assert.equal((await handleEngagement(contact(fields, { headers: { 'CF-Connecting-IP': `192.0.2.${i}` } }), env(bucket))).status, 202);
  assert.equal((await handleEngagement(contact(fields, { headers: { 'CF-Connecting-IP': '192.0.2.101' } }), env(bucket))).status, 429);
  assert.equal(messages(bucket).length, 100); assert.equal(bucket.value(rateKey).count, 100); assert.ok(Object.keys(bucket.value(rateKey).hourly).length <= 100);
  time = Date.parse('2026-11-12T05:00:00Z');
  assert.equal((await handleEngagement(contact(), env(bucket))).status, 202); assert.equal(bucket.value(rateKey).count, 1);
});
test('CAS handles concurrent reservations and bounds conflicts without lost updates', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  const results = await Promise.all([handleEngagement(contact(), env(bucket)), handleEngagement(contact(), env(bucket))]);
  assert.deepEqual(results.map(result => result.status), [202, 202]); assert.equal(bucket.value(rateKey).count, 2); assert.equal(messages(bucket).length, 2);
  const puts = bucket.calls.filter(call => call[0] === 'put' && call[1] === rateKey);
  assert.ok(puts.some(call => call[2].onlyIf.etagDoesNotMatch === '*')); assert.ok(puts.some(call => typeof call[2].onlyIf.etagMatches === 'string'));
  const busy = new Bucket(); busy.conflicts = 99;
  assert.equal((await handleEngagement(contact(), env(busy))).status, 503);
  assert.equal(busy.calls.filter(call => call[0] === 'put').length, 4); assert.equal(messages(busy).length, 0);
  const corrupt = new Bucket(); corrupt.seed(rateKey, { count: -1 });
  assert.equal((await handleEngagement(contact(), env(corrupt))).status, 503); assert.equal(corrupt.calls.filter(call => call[0] === 'put').length, 0);
});
test('analytics aggregates only allowed events, paths and referrer hostnames', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-11T04:59:00Z')); const bucket = new Bucket();
  assert.equal((await handleEngagement(event({ referrer: 'WWW.Example.test' }), env(bucket))).status, 202);
  assert.equal((await handleEngagement(event({ event: 'github_click' }), env(bucket))).status, 202);
  assert.equal((await handleEngagement(event({ path: '/404' }), env(bucket))).status, 202);
  const value = bucket.value('analytics/2026-11-10.json');
  assert.equal(value.events.pageview, 2); assert.equal(value.events.github_click, 1); assert.equal(value.referrers['www.example.test'], 1);
  assert.equal(value.paths['/'].github_click, 1); assert.equal(value.paths['/404'].pageview, 1);
  const stored = JSON.stringify([...bucket.objects]);
  for (const forbidden of ['192.0.2.1', 'test-private-agent', 'test-private-cookie', 'visitorId', 'https://']) assert.equal(stored.includes(forbidden), false);
});
test('analytics rejects cross-origin, raw URLs, unknown fields and unknown routes', async () => {
  const bucket = new Bucket();
  for (const value of [null, 'https://evil.test']) assert.equal((await handleEngagement(event({}, { headers: { Origin: value } }), env(bucket))).status, 403);
  for (const input of [{ event: 'arbitrary' }, { path: '/?secret=x' }, { path: '/#contact' }, { path: 'https://example.test/' }, { path: '/api/private/messages' }, { referrer: 'https://example.test/path?q=pii' }, { referrer: 'user@example.test' }, { referrer: 'example.test:443' }, { referrer: '192.0.2.1' }, { visitorId: 'tracking' }]) assert.equal((await handleEngagement(event(input), env(bucket))).status, 400);
  assert.deepEqual(bucket.calls, []);
  assert.equal((await handleEngagement(event({ path: '/writing/not-a-published-article' }), env(bucket))).status, 400);
  assert.equal(bucket.calls.filter(call => call[0] === 'put').length, 0);
});
test('analytics recognizes bundled and newly synchronized article/topic paths', async () => {
  const bucket = new Bucket();
  assert.equal((await handleEngagement(event({ path: `/writing/${articles[0].slug}` }), env(bucket))).status, 202);
  bucket.seed('writing/archive-v1.json', { articles: [{ slug: 'new-runtime-article', tags: ['newtopic'] }] });
  for (const path of ['/writing/new-runtime-article', '/writing/topics/newtopic']) assert.equal((await handleEngagement(event({ path }), env(bucket))).status, 202);
  assert.equal((await handleEngagement(event({ path: '/writing/topics/not-a-real-topic' }), env(bucket))).status, 400);
});
test('analytics CAS preserves concurrent counts and bounds failures', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  const results = await Promise.all([handleEngagement(event(), env(bucket)), handleEngagement(event(), env(bucket)), handleEngagement(event(), env(bucket))]);
  assert.deepEqual(results.map(result => result.status), [202, 202, 202]); assert.equal(bucket.value('analytics/2026-11-11.json').events.pageview, 3);
  const busy = new Bucket(); busy.conflicts = 99;
  assert.equal((await handleEngagement(event(), env(busy))).status, 503); assert.equal(busy.calls.filter(call => call[0] === 'put').length, 4);
  const broken = new Bucket(); broken.get = async () => { throw new Error('private-error'); };
  assert.equal((await handleEngagement(event(), env(broken))).status, 503);
});
test('analytics caps referrer and path cardinality using an overflow bucket', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  for (let i = 0; i < 70; i += 1) assert.equal((await handleEngagement(event({ referrer: `source-${i}.example` }), env(bucket))).status, 202);
  const archive = Array.from({ length: 130 }, (_, i) => ({ slug: `cardinality-article-${i}`, tags: [] }));
  bucket.seed('writing/archive-v1.json', { articles: archive });
  for (const article of archive) assert.equal((await handleEngagement(event({ path: `/writing/${article.slug}` }), env(bucket))).status, 202);
  const value = bucket.value('analytics/2026-11-11.json');
  assert.equal(Object.keys(value.referrers).length, 64); assert.ok(value.referrers['(other)'] >= 7);
  assert.equal(Object.keys(value.paths).length, 128); assert.ok(value.paths['(other)'].pageview >= 3); assert.equal(value.events.pageview, 200);
});
function seedMessage(bucket, time, index = 0) {
  const id = `${String(9_999_999_999_999 - time).padStart(13, '0')}-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  bucket.seed(`contact/messages/${id}.json`, { version: 1, id, receivedAt: new Date(time).toISOString(), name: fields.name, email: fields.email, message: fields.message });
  return id;
}
test('private messages are newest-first, bounded, resumable and marked untrusted', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  for (let i = 0; i < 120; i += 1) seedMessage(bucket, now - i * 60_000, i);
  seedMessage(bucket, now - 48 * 3_600_000, 999);
  const first = await (await handleEngagement(privateRequest('/api/private/messages'), env(bucket))).json();
  assert.equal(first.messages.length, 100); assert.equal(first.limit, 100); assert.equal(first.truncated, true); assert.equal(first.untrustedContent, true); assert.ok(first.nextCursor);
  assert.equal(first.messages[0].receivedAt, new Date(now).toISOString()); assert.equal(first.since, new Date(now - 24 * 3_600_000).toISOString());
  const query = new URLSearchParams({ since: first.since, cursor: first.nextCursor });
  const second = await (await handleEngagement(privateRequest(`/api/private/messages?${query}`), env(bucket))).json();
  assert.equal(second.messages.length, 20); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.messages, ...second.messages].map(message => message.id)).size, 120);
  assert.ok(bucket.calls.filter(call => call[0] === 'list').every(call => call[1].limit <= 100));
  const limited = await (await handleEngagement(privateRequest('/api/private/messages?limit=2'), env(bucket))).json(); assert.equal(limited.messages.length, 2);
});
test('message since/limit validation and owner deletion retain authorization boundaries', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  const old = seedMessage(bucket, now - 25 * 3_600_000, 1), recent = seedMessage(bucket, now - 3_600_000, 2);
  const response = await (await handleEngagement(privateRequest('/api/private/messages'), env(bucket))).json(); assert.deepEqual(response.messages.map(message => message.id), [recent]);
  for (const query of ['since=bad', 'since=2026-02-30T00:00:00Z', 'since=2999-01-01T00:00:00Z', 'limit=0', 'limit=101', 'limit=abc', 'cursor=']) assert.equal((await handleEngagement(privateRequest(`/api/private/messages?${query}`), env(bucket))).status, 400);
  assert.equal((await handleEngagement(privateRequest(`/api/private/messages/${recent}`, { method: 'DELETE', headers: {} }), env(bucket))).status, 401);
  assert.equal((await handleEngagement(privateRequest(`/api/private/messages/${recent}`, { method: 'DELETE' }), env(bucket))).status, 204);
  assert.equal(bucket.objects.has(`contact/messages/${recent}.json`), false); assert.equal(bucket.objects.has(`contact/messages/${old}.json`), true);
  assert.equal((await handleEngagement(privateRequest('/api/private/messages/not-an-id', { method: 'DELETE' }), env(bucket))).status, 400);
});
test('Toronto dates and limiter expirations handle DST boundaries', async t => {
  let time; t.mock.method(Date, 'now', () => time);
  for (const [instant, day, midnight] of [['2026-03-08T05:00:00Z', '2026-03-08', '2026-03-09T04:00:00.000Z'], ['2026-11-01T04:00:00Z', '2026-11-01', '2026-11-02T05:00:00.000Z']]) {
    time = Date.parse(instant); const bucket = new Bucket();
    assert.equal((await handleEngagement(contact(), env(bucket))).status, 202);
    assert.equal(bucket.value(rateKey).day, day); assert.equal(new Date(bucket.value(rateKey).expiresAt).toISOString(), midnight);
    assert.equal((await handleEngagement(event(), env(bucket))).status, 202); assert.ok(bucket.objects.has(`analytics/${day}.json`));
  }
});
test('owner analytics reads exactly 30 Toronto dates and returns only aggregate summaries', async t => {
  t.mock.method(Date, 'now', () => now); const bucket = new Bucket();
  assert.equal((await handleEngagement(event(), env(bucket))).status, 202);
  assert.equal((await handleEngagement(event({ event: 'contact_submitted' }), env(bucket))).status, 202);
  const before = bucket.calls.length;
  const response = await handleEngagement(privateRequest('/api/private/analytics'), env(bucket)); assert.equal(response.status, 200);
  const summary = await response.json(); assert.deepEqual(summary.range, { from: '2026-10-13', to: '2026-11-11', timeZone: 'America/Toronto', days: 30 });
  assert.equal(summary.daily.length, 30); assert.equal(summary.totals.events.pageview, 1); assert.equal(summary.totals.events.contact_submitted, 1);
  assert.equal(bucket.calls.slice(before).filter(call => call[0] === 'get').length, 30);
  assert.equal(Object.hasOwn(summary, 'visitors'), false); assert.equal(JSON.stringify(summary).includes('192.0.2.1'), false);
  bucket.get = async () => { throw undefined; };
  assert.equal((await handleEngagement(privateRequest('/api/private/analytics'), env(bucket))).status, 503);
});

test('both exact public origins accept only their own same-origin analytics', async t => {
  t.mock.method(Date, 'now', () => now);
  const sitesOrigin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
  for (const [site, other] of [[origin, sitesOrigin], [sitesOrigin, origin]]) {
    const bucket = new Bucket();
    assert.equal((await handleEngagement(event({}, { site }), env(bucket))).status, 202);
    assert.equal(bucket.value('analytics/2026-11-11.json').events.pageview, 1);
    const noWrites = new Bucket();
    for (const header of [other, null, `${site}/`, `${site}.evil.test`]) {
      assert.equal((await handleEngagement(event({}, { site, headers: { Origin: header } }), env(noWrites))).status, 403);
    }
    assert.equal((await handleEngagement(event({}, { site }), env(noWrites, { ANALYTICS_ENABLED: 'false' }))).status, 204);
    assert.deepEqual(noWrites.calls, []);
  }
});

test('HTTP, lookalikes and other Sites cannot contribute analytics', async () => {
  const sitesOrigin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
  const bucket = new Bucket();
  for (const site of ['http://desmondgilmour.com', sitesOrigin.replace('https:', 'http:'), `${sitesOrigin}.evil.test`, 'https://another-site.playfulporpoise2.chatgpt.site', 'https://des-personal-site-preview.other-workspace.chatgpt.site', 'https://desmondgilmour.com.evil.test']) {
    assert.equal((await handleEngagement(event({}, { site, headers: { Origin: origin } }), env(bucket))).status, 204);
  }
  assert.deepEqual(bucket.calls, []);
});

test('privacy opt-out headers suppress analytics on both approved origins', async () => {
  const bucket = new Bucket();
  for (const site of [origin, 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site']) {
    for (const headers of [{ DNT: '1' }, { DNT: 'yes' }, { 'Sec-GPC': '1' }]) {
      assert.equal((await handleEngagement(event({}, { site, headers }), env(bucket))).status, 204);
    }
  }
  assert.deepEqual(bucket.calls, []);
});

test('referrals between the approved public hosts are internal aggregates', async t => {
  t.mock.method(Date, 'now', () => now);
  const bucket = new Bucket();
  for (const referrer of ['desmondgilmour.com', 'des-personal-site-preview.playfulporpoise2.chatgpt.site']) {
    assert.equal((await handleEngagement(event({ referrer }), env(bucket))).status, 202);
  }
  assert.deepEqual(bucket.value('analytics/2026-11-11.json').referrers, { '(internal)': 2 });
});

test('public Sites access does not authorize private inbox, analytics or deletion', async () => {
  const site = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site', bucket = new Bucket();
  for (const [path, method] of [['/api/private/messages', 'GET'], ['/api/private/analytics', 'GET'], ['/api/private/messages/0000000000000-00000000-0000-0000-0000-000000000000', 'DELETE']]) {
    for (const headers of [{}, { Origin: site, 'OAI-Sites-Authorization': 'public-site-access', 'X-Des-Sync': 'devto-v1' }]) {
      const result = await handleEngagement(new Request(`${site}${path}`, { method, headers }), env(bucket));
      assert.equal(result.status, 401);
    }
  }
  assert.deepEqual(bucket.calls, []);
});

test('public Sites contact retains the enabled inbox and same-origin guards', async t => {
  t.mock.method(Date, 'now', () => now);
  const site = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site', bucket = new Bucket();
  assert.equal((await handleEngagement(contact(fields, { site }), env(bucket, { CONTACT_MODE: 'draft' }))).status, 503);
  assert.equal((await handleEngagement(contact(fields, { site, headers: { Origin: origin } }), env(bucket))).status, 403);
  assert.deepEqual(bucket.calls, []);
  assert.equal((await handleEngagement(contact(fields, { site }), env(bucket))).status, 202);
  assert.equal(messages(bucket).length, 1);
});

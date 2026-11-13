import { authorizeWriter } from './writerAuth.mjs';
import bundledArticles from '../client/src/data/article-index.json' with { type: 'json' };
import { topicSlug } from '../client/src/lib/writingTopics.js';
import { isAnalyticsOrigin, isInternalAnalyticsReferrer } from '../client/src/lib/analyticsOrigins.js';
const ZONE = 'America/Toronto';
const HOUR = 3_600_000, DAY = 24 * HOUR, CONTACT_LIMIT = 32 * 1024, RETRIES = 4;
const RATE_KEY = 'contact/rate/limits.json', MESSAGE_PREFIX = 'contact/messages/', REVERSE_EPOCH = 9_999_999_999_999;
const MESSAGE_ID = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EVENTS = ['pageview', 'contact_submitted', 'email_click', 'github_click', 'linkedin_click'];
const PATH_CAP = 128, REFERRER_CAP = 64;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, shortControls = /[\u0000-\u001f\u007f]/;
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const counter = value => Number.isSafeInteger(value) && value >= 0;
const emptyEvents = () => Object.fromEntries(EVENTS.map(event => [event, 0]));
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
class Failure extends Error { constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; } }
function json(body, status = 200, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}
function receipt(status, message, success = false, extra = {}) {
  const title = success ? 'Message received' : 'Message not sent';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Desmond Gilmour</title></head><body><main><h1>${title}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to Desmond Gilmour’s website</a></p></main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", ...extra } });
}
function dayAt(now) { const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map(({ type, value }) => [type, value])); return `${parts.year}-${parts.month}-${parts.day}`; }
function dayExpires(now) {
  // Find Toronto midnight, including 23/25-hour DST days.
  const day = dayAt(now); let low = now, high = now + 26 * HOUR;
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (dayAt(middle) === day) low = middle; else high = middle; }
  return high;
}
function method(request, expected) { if (request.method !== expected) throw new Failure(405, `Use ${expected}.`); }
function storage(env) {
  if (!env?.BUCKET || typeof env.BUCKET.get !== 'function' || typeof env.BUCKET.put !== 'function') throw new Failure(503, 'Storage is temporarily unavailable. Please try again later.');
  return env.BUCKET;
}
async function readBody(request, maximum) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Failure(413, 'The request is too large. Please shorten it and try again.');
  const reader = request.body?.getReader(); if (!reader) throw new Failure(400, 'A request body is required.');
  const chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) { await reader.cancel(); throw new Failure(413, 'The request is too large. Please shorten it and try again.'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Failure(400, 'Use valid UTF-8 text.'); }
}
async function payload(request, maximum, allowForm = false) {
  const type = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !(allowForm && type === 'application/x-www-form-urlencoded')) throw new Failure(415, 'Use JSON or the website’s contact form.');
  const text = await readBody(request, maximum);
  try {
    if (type === 'application/json') return JSON.parse(text);
    const values = new URLSearchParams(text), result = Object.create(null);
    for (const [key, value] of values) { if (Object.hasOwn(result, key)) throw new Error('Duplicate field'); result[key] = value; } return result;
  } catch { throw new Failure(400, 'The submitted form could not be read.'); }
}
function contactFields(input) {
  if (!record(input) || !keysOnly(input, ['name', 'email', 'message', '_gotcha'])) throw new Failure(400, 'Use the name, email and message fields.');
  if (input._gotcha !== undefined && (typeof input._gotcha !== 'string' || input._gotcha.trim())) throw new Failure(400, 'The message could not be accepted.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || shortControls.test(input.name)) throw new Failure(400, 'Enter a name of up to 100 characters.');
  if (typeof input.email !== 'string' || input.email.length > 254 || shortControls.test(input.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new Failure(400, 'Enter a valid email address.');
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 5000 || controls.test(input.message)) throw new Failure(400, 'Enter a message of up to 5,000 characters.');
  return { name: input.name.trim(), email: input.email.trim(), message: input.message.trim().replaceAll('\r\n', '\n') };
}
function condition(object) {
  if (!object) return { etagDoesNotMatch: '*' };
  if (typeof object.etag !== 'string' || !object.etag) throw new Error('Storage did not supply an ETag'); return { etagMatches: object.etag };
}
async function cas(bucket, key, update) {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const current = await bucket.get(key); if (current?.size > 512 * 1024) throw new Error('Stored aggregate exceeds its limit');
    const next = update(current ? await current.json() : null); let result;
    try { result = await bucket.put(key, JSON.stringify(next), { onlyIf: condition(current), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } }); }
    catch (error) { if (error?.status === 412 || error?.statusCode === 412 || error?.name === 'PreconditionFailed') continue; throw error; }
    if (result !== null && result !== undefined) return next;
  }
  throw new Failure(503, 'The service is temporarily busy. Please try again shortly.', 5);
}
async function ipKey(request, verifier, windowEnd) {
  // Trusted Cloudflare header: used in memory only, never copied to a record.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 45 || !/^[0-9a-f:.]+$/i.test(ip) || (!ip.includes('.') && !ip.includes(':'))) throw new Failure(503, 'The contact service is temporarily unavailable.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(verifier.toLowerCase()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`contact-rate:${windowEnd}:${ip.toLowerCase()}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validRate(value) {
  if (!record(value) || value.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !counter(value.count) || value.count > 100 || !Number.isSafeInteger(value.expiresAt) || !record(value.hourly) || Object.keys(value.hourly).length > 100) throw new Error('Invalid saved rate limit');
  for (const [hash, entry] of Object.entries(value.hourly)) if (!/^[a-f0-9]{64}$/.test(hash) || !record(entry) || !counter(entry.count) || entry.count > 5 || !Number.isSafeInteger(entry.expiresAt)) throw new Error('Invalid saved rate limit');
  return value;
}
async function reserveContact(request, env, bucket, now) {
  const verifier = env?.WRITING_SERVICE_TOKEN_SHA256;
  if (typeof verifier !== 'string' || !/^[a-f0-9]{64}$/i.test(verifier)) throw new Failure(503, 'The contact service is temporarily unavailable.');
  const hourEnd = (Math.floor(now / HOUR) + 1) * HOUR;
  const hash = await ipKey(request, verifier, hourEnd), today = dayAt(now), expiry = dayExpires(now);
  await cas(bucket, RATE_KEY, saved => {
    const prior = saved === null ? null : validRate(saved);
    const value = prior?.day === today && prior.expiresAt > now ? prior : { version: 1, day: today, count: 0, expiresAt: expiry, hourly: {} };
    const hourly = Object.fromEntries(Object.entries(value.hourly).filter(([, entry]) => entry.expiresAt > now).map(([key, entry]) => [key, { count: entry.count, expiresAt: entry.expiresAt }]));
    const used = hourly[hash]?.count || 0;
    if (used >= 5) throw new Failure(429, 'Too many messages. Please try again in an hour.', Math.max(1, Math.ceil((hourEnd - now) / 1000)));
    if (value.count >= 100) throw new Failure(429, 'The inbox has reached its daily limit. Please try again tomorrow.', Math.max(1, Math.ceil((expiry - now) / 1000)));
    hourly[hash] = { count: used + 1, expiresAt: hourEnd };
    // A single conditional object atomically reserves both quotas. R2 has no
    // native TTL: expired hashes are ignored/pruned on the next successful write.
    return { version: 1, day: today, count: value.count + 1, expiresAt: expiry, hourly };
  });
}
async function saveContact(request, env, asHtml) {
  method(request, 'POST');
  if (env?.CONTACT_MODE !== 'inbox') throw new Failure(503, 'The contact inbox is not available. Please use the email link on the website.');
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new Failure(403, 'Submit the form from this website.');
  const fields = contactFields(await payload(request, CONTACT_LIMIT, true)), bucket = storage(env), now = Date.now();
  await reserveContact(request, env, bucket, now);
  const id = `${String(REVERSE_EPOCH - now).padStart(13, '0')}-${crypto.randomUUID()}`;
  const message = { version: 1, id, receivedAt: new Date(now).toISOString(), ...fields };
  const written = await bucket.put(`${MESSAGE_PREFIX}${id}.json`, JSON.stringify(message), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
  if (!written) throw new Error('Message write was not confirmed');
  return asHtml ? receipt(202, 'Your message has been saved privately for Desmond to review.', true) : json({ ok: true }, 202);
}
function pathSyntax(path) { return typeof path === 'string' && path.length <= 240 && (path === '/' || path === '/404' || /^\/writing(?:\/[a-z0-9][a-z0-9-]*)?(?:\/[a-z0-9][a-z0-9-]*)?$/.test(path)); }
function articlePaths(articles) {
  const paths = new Set(['/', '/writing', '/404']);
  for (const article of articles) {
    if (typeof article?.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) && article.slug.length <= 200) paths.add(`/writing/${article.slug}`);
    if (Array.isArray(article?.tags)) for (const tag of article.tags.slice(0, 10)) if (typeof tag === 'string' && tag.length <= 64) paths.add(`/writing/topics/${topicSlug(tag)}`);
  }
  return paths;
}
const builtInPaths = articlePaths(bundledArticles);
async function knownPath(path, bucket) {
  if (builtInPaths.has(path)) return true;
  const object = await bucket.get('writing/archive-v1.json'); if (!object) return false;
  if (object.size > 5 * 1024 * 1024) throw new Error('Writing archive exceeds its limit');
  const archive = await object.json();
  if (!record(archive) || !Array.isArray(archive.articles) || archive.articles.length > 1000) throw new Error('Invalid writing archive');
  return articlePaths(archive.articles).has(path);
}
function referrerHost(value) {
  if (value === null) return '(direct)';
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim() || value.split('.').length < 2 || !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || /^[\d.]+$/.test(value)) throw new Failure(400, 'Referrer must be a hostname or null.');
  const host = value.toLowerCase(); return isInternalAnalyticsReferrer(host) ? '(internal)' : host;
}
function analyticsFields(input) {
  if (!record(input) || !keysOnly(input, ['event', 'path', 'referrer']) || !EVENTS.includes(input.event) || !pathSyntax(input.path) || !Object.hasOwn(input, 'referrer')) throw new Failure(400, 'Invalid analytics event.');
  return { event: input.event, path: input.path, referrer: referrerHost(input.referrer) };
}
function analyticsRecord(day) { return { version: 1, day, events: emptyEvents(), paths: {}, referrers: {} }; }
function eventCounts(value) { if (!record(value) || !keysOnly(value, EVENTS) || EVENTS.some(event => !counter(value[event]))) throw new Error('Invalid aggregate counters'); }
function validAnalytics(value, day) {
  if (!record(value) || value.version !== 1 || value.day !== day || !record(value.paths) || !record(value.referrers) || Object.keys(value.paths).length > PATH_CAP || Object.keys(value.referrers).length > REFERRER_CAP) throw new Error('Invalid analytics aggregate');
  if ((!Object.hasOwn(value.paths, '(other)') && Object.keys(value.paths).length >= PATH_CAP) || (!Object.hasOwn(value.referrers, '(other)') && Object.keys(value.referrers).length >= REFERRER_CAP)) throw new Error('Aggregate overflow slot is missing');
  eventCounts(value.events);
  for (const [path, counts] of Object.entries(value.paths)) { if (path !== '(other)' && !pathSyntax(path)) throw new Error('Invalid aggregate path'); eventCounts(counts); }
  for (const [host, count] of Object.entries(value.referrers)) { if (!counter(count)) throw new Error('Invalid referrer counter'); if (!['(direct)', '(internal)', '(other)'].includes(host)) { try { referrerHost(host); } catch { throw new Error('Invalid aggregate referrer'); } } }
  return value;
}
function increment(value, amount = 1) { const sum = value + amount; if (!Number.isSafeInteger(sum)) throw new Error('Counter capacity reached'); return sum; }
function boundedKey(map, key, maximum) { return Object.hasOwn(map, key) || Object.keys(map).filter(existing => existing !== '(other)').length < maximum - 1 ? key : '(other)'; }
async function recordAnalytics(request, env) {
  method(request, 'POST');
  const origin = new URL(request.url).origin;
  if (env?.ANALYTICS_ENABLED !== 'true' || !isAnalyticsOrigin(origin)) return json(null, 204);
  if (request.headers.get('Origin') !== origin) throw new Failure(403, 'Analytics accepts only same-origin events.');
  if (/^(1|yes)$/i.test(request.headers.get('DNT') || '') || request.headers.get('Sec-GPC') === '1') return json(null, 204);
  const event = analyticsFields(await payload(request, 2048)), bucket = storage(env);
  if (!await knownPath(event.path, bucket)) throw new Failure(400, 'Unknown site path.');
  const day = dayAt(Date.now());
  await cas(bucket, `analytics/${day}.json`, saved => {
    const value = saved === null ? analyticsRecord(day) : validAnalytics(saved, day);
    // Construct aggregate fields only. Request headers and identities never enter storage.
    const next = { version: 1, day, events: { ...value.events }, paths: { ...value.paths }, referrers: { ...value.referrers } };
    next.events[event.event] = increment(next.events[event.event]);
    const path = boundedKey(next.paths, event.path, PATH_CAP);
    next.paths[path] = { ...(next.paths[path] || emptyEvents()) }; next.paths[path][event.event] = increment(next.paths[path][event.event]);
    if (event.event === 'pageview') { const referrer = boundedKey(next.referrers, event.referrer, REFERRER_CAP); next.referrers[referrer] = increment(next.referrers[referrer] || 0); }
    return next;
  });
  return json({ ok: true }, 202);
}
function savedMessage(value, id) {
  if (!record(value) || value.version !== 1 || value.id !== id || !MESSAGE_ID.test(id) || typeof value.receivedAt !== 'string' || !Number.isFinite(Date.parse(value.receivedAt)) || new Date(value.receivedAt).toISOString() !== value.receivedAt) throw new Error('Invalid stored message');
  return { id, receivedAt: value.receivedAt, ...contactFields({ name: value.name, email: value.email, message: value.message }) };
}
async function listMessages(request, env) {
  const bucket = storage(env), params = new URL(request.url).searchParams, rawSince = params.get('since');
  const rawLimit = params.get('limit'), limit = rawLimit === null ? 100 : Number(rawLimit);
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Failure(400, 'Limit must be between 1 and 100.');
  const since = rawSince === null ? Date.now() - DAY : Date.parse(rawSince);
  if ((rawSince !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(rawSince) || !Number.isFinite(since) || new Date(since).toISOString().slice(0, 19) !== rawSince.slice(0, 19))) || since > Date.now()) throw new Failure(400, 'Use a past ISO UTC timestamp for since.');
  const cursor = params.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > 2048 || /[\u0000-\u0020\u007f]/.test(cursor))) throw new Failure(400, 'Invalid message cursor.');
  const listing = await bucket.list({ prefix: MESSAGE_PREFIX, limit, ...(cursor ? { cursor } : {}) });
  if (!Array.isArray(listing.objects) || listing.objects.length > limit) throw new Error('Invalid storage listing');
  const messages = [];
  for (const item of listing.objects) {
    const id = item.key?.slice(MESSAGE_PREFIX.length, -5);
    if (!item.key?.startsWith(MESSAGE_PREFIX) || !item.key.endsWith('.json') || !MESSAGE_ID.test(id)) continue;
    if (REVERSE_EPOCH - Number(id.slice(0, 13)) < since) continue;
    const object = await bucket.get(item.key); if (!object) continue;
    if (object.size > CONTACT_LIMIT + 1024) throw new Error('Stored message exceeds its limit');
    const message = savedMessage(await object.json(), id); if (Date.parse(message.receivedAt) >= since) messages.push(message);
  }
  messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
  return json({ messages, since: new Date(since).toISOString(), limit, truncated: Boolean(listing.truncated), nextCursor: listing.truncated && typeof listing.cursor === 'string' ? listing.cursor : null, untrustedContent: true });
}
async function deleteMessage(path, env) {
  const id = path.slice('/api/private/messages/'.length); if (!MESSAGE_ID.test(id)) throw new Failure(400, 'Invalid message identifier.');
  await storage(env).delete(`${MESSAGE_PREFIX}${id}.json`); return json(null, 204);
}
async function analyticsSummary(env) {
  const bucket = storage(env), today = dayAt(Date.now()), todayUtc = Date.parse(`${today}T00:00:00.000Z`);
  const days = Array.from({ length: 30 }, (_, index) => new Date(todayUtc - (29 - index) * DAY).toISOString().slice(0, 10));
  const totals = { events: emptyEvents(), paths: {}, referrers: {} }, daily = [];
  for (let offset = 0; offset < days.length; offset += 5) {
    const records = await Promise.all(days.slice(offset, offset + 5).map(async day => {
      const object = await bucket.get(`analytics/${day}.json`); if (!object) return analyticsRecord(day);
      if (object.size > 512 * 1024) throw new Error('Stored aggregate exceeds its limit'); return validAnalytics(await object.json(), day);
    }));
    for (const value of records) {
      for (const event of EVENTS) totals.events[event] = increment(totals.events[event], value.events[event]);
      for (const [path, counts] of Object.entries(value.paths)) {
        const key = boundedKey(totals.paths, path, PATH_CAP); totals.paths[key] ||= emptyEvents();
        for (const event of EVENTS) totals.paths[key][event] = increment(totals.paths[key][event], counts[event]);
      }
      for (const [host, count] of Object.entries(value.referrers)) { const key = boundedKey(totals.referrers, host, REFERRER_CAP); totals.referrers[key] = increment(totals.referrers[key] || 0, count); }
      daily.push({ day: value.day, events: { ...value.events } });
    }
  }
  return json({ range: { from: days[0], to: today, timeZone: ZONE, days: 30 }, totals, daily });
}

/** Handle accountless engagement endpoints; return null for unrelated routes. */
export async function handleEngagement(request, env) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const contact = path === '/api/contact', analytics = path === '/api/analytics';
  const messages = path === '/api/private/messages', deletion = path.startsWith('/api/private/messages/'), summary = path === '/api/private/analytics';
  if (!contact && !analytics && !messages && !deletion && !summary) return null;
  const asHtml = contact && request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
  try {
    if (messages || deletion || summary) {
      // Authenticate before every private storage read, list, write, and delete.
      if (!await authorizeWriter(request, env)) return json({ error: 'Writer authorization required.' }, 401);
      method(request, deletion ? 'DELETE' : 'GET');
      if (messages) return await listMessages(request, env);
      if (deletion) return await deleteMessage(path, env);
      return await analyticsSummary(env);
    }
    if (contact) return await saveContact(request, env, asHtml);
    return await recordAnalytics(request, env);
  } catch (error) {
    // Never log visitor input, credentials, IPs, or storage error text.
    const status = error instanceof Failure ? error.status : 503;
    const message = error instanceof Failure ? error.message : 'The service is temporarily unavailable. Please try again later.';
    const extra = error?.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
    if (status === 405) extra.Allow = messages || summary ? 'GET' : deletion ? 'DELETE' : 'POST';
    return asHtml ? receipt(status, message, false, extra) : json({ error: message }, status, extra);
  }
}

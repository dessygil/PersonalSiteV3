import bundledArticles from '../client/src/data/article-index.json' with { type: 'json' };

const ENDPOINT = '/api/article-reactions';
const PREFIX = 'article-reactions/v1/';
const RATE_KEY = `${PREFIX}rate.json`;
const HOUR = 3_600_000;
const MAX_BODY_BYTES = 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_ACTIVE_VOTES = 10_000;
const MAX_SLUGS = 1000;
const PER_IP_LIMIT = 60;
const GLOBAL_LIMIT = 2000;
const MAX_RETRIES = 4;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSlug = value => typeof value === 'string' && value.length <= 200 && SLUG.test(value);
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const fallbackSlugs = new Set(bundledArticles.map(article => article.slug).filter(validSlug));

class Failure extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
function response(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra,
  } });
}
function bucketFor(env, writing = false) {
  if (!env?.BUCKET || typeof env.BUCKET.get !== 'function' || (writing && typeof env.BUCKET.put !== 'function')) throw new Failure(503, 'Article reactions are temporarily unavailable.');
  return env.BUCKET;
}
function visitorToken(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Failure(400, 'A valid browser visitor token is required.');
  return value.toLowerCase();
}
async function hmacFor(env) {
  const pepper = env?.REACTION_HMAC_SECRET;
  if (typeof pepper !== 'string' || !/^[a-f0-9]{64}$/i.test(pepper)) throw new Failure(503, 'Article reactions are temporarily unavailable.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper.toLowerCase()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async value => {
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  };
}
async function knownSlugs(bucket, slugs) {
  if (slugs.every(slug => fallbackSlugs.has(slug))) return;
  const known = new Set(fallbackSlugs);
  const archive = await bucket.get('writing/archive-v1.json');
  if (archive) {
    if (archive.size > 5 * 1024 * 1024) throw new Error('Writing archive exceeds its size limit');
    const saved = await archive.json();
    if (!isRecord(saved) || !Array.isArray(saved.articles) || saved.articles.length > MAX_SLUGS) throw new Error('Invalid writing archive');
    for (const article of saved.articles) if (validSlug(article?.slug)) known.add(article.slug);
  }
  if (!slugs.every(slug => known.has(slug))) throw new Failure(404, 'Article not found.');
}
async function readPayload(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Failure(415, 'Use a JSON reaction request.');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Failure(413, 'Reaction request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new Failure(400, 'A reaction request is required.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Failure(413, 'Reaction request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Failure(400, 'The reaction request could not be read.'); }
  if (!isRecord(value) || !onlyKeys(value, ['visitor', 'liked']) || typeof value.liked !== 'boolean') throw new Failure(400, 'Supply a visitor token and a boolean liked value.');
  return { visitor: visitorToken(value.visitor), liked: value.liked };
}
function condition(object) {
  if (!object) return { etagDoesNotMatch: '*' };
  if (typeof object.etag !== 'string' || !object.etag) throw new Error('Storage omitted its ETag');
  return { etagMatches: object.etag };
}
async function putIfUnchanged(bucket, key, next, object) {
  try {
    return await bucket.put(key, JSON.stringify(next), {
      onlyIf: condition(object), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
  } catch (error) {
    if (error?.status === 412 || error?.statusCode === 412 || error?.name === 'PreconditionFailed') return null;
    throw error;
  }
}
function stateKey(slug) { return `${PREFIX}articles/${slug}.json`; }
function validateState(value, slug) {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'slug', 'count', 'voters']) || value.version !== 1 || value.slug !== slug || !Number.isInteger(value.count) || value.count < 0 || value.count > MAX_ACTIVE_VOTES || !isRecord(value.voters)) throw new Error('Invalid stored reaction state');
  const voters = Object.entries(value.voters);
  if (voters.length !== value.count || voters.some(([hash, liked]) => !HASH.test(hash) || liked !== true)) throw new Error('Invalid stored reaction votes');
  return value;
}
async function readState(bucket, slug) {
  const object = await bucket.get(stateKey(slug));
  if (!object) return { object: null, state: { version: 1, slug, count: 0, voters: {} } };
  if (object.size > MAX_STATE_BYTES) throw new Error('Reaction state exceeds its size limit');
  return { object, state: validateState(await object.json(), slug) };
}
function trustedIp(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (typeof ip !== 'string' || ip.length > 45) throw new Failure(503, 'Article reactions are temporarily unavailable.');
  if (ip.includes(':')) {
    try { return new URL(`http://[${ip}]/`).hostname.toLowerCase(); } catch { /* Reject malformed IPv6 below. */ }
  } else {
    const pieces = ip.split('.');
    if (pieces.length === 4 && pieces.every(piece => /^(0|[1-9]\d{0,2})$/.test(piece) && Number(piece) <= 255)) return pieces.join('.');
  }
  throw new Failure(503, 'Article reactions are temporarily unavailable.');
}
function validateRate(value) {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'window', 'expiresAt', 'count', 'ips']) || value.version !== 1 || !Number.isSafeInteger(value.window) || value.window % HOUR !== 0 || value.expiresAt !== value.window + HOUR || !Number.isInteger(value.count) || value.count < 0 || value.count > GLOBAL_LIMIT || !isRecord(value.ips)) throw new Error('Invalid reaction rate state');
  const entries = Object.entries(value.ips);
  if (entries.length > GLOBAL_LIMIT || entries.some(([hash, count]) => !HASH.test(hash) || !Number.isInteger(count) || count < 1 || count > PER_IP_LIMIT) || entries.reduce((sum, [, count]) => sum + count, 0) !== value.count) throw new Error('Invalid reaction rate counters');
  return value;
}
async function reserveChange(request, bucket, mac) {
  const now = Date.now(), window = Math.floor(now / HOUR) * HOUR;
  const hash = await mac(`article-reactions:v1:rate:${window}:${trustedIp(request)}`);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const object = await bucket.get(RATE_KEY);
    if (object?.size > MAX_STATE_BYTES) throw new Error('Reaction rate state exceeds its size limit');
    const saved = object ? validateRate(await object.json()) : null;
    if (saved && saved.window > window) throw new Error('Reaction rate window is invalid');
    const rate = saved?.window === window ? saved : { version: 1, window, expiresAt: window + HOUR, count: 0, ips: {} };
    const used = rate.ips[hash] || 0;
    const retryAfter = Math.max(1, Math.ceil((rate.expiresAt - now) / 1000));
    if (used >= PER_IP_LIMIT || rate.count >= GLOBAL_LIMIT) throw new Failure(429, 'Too many reaction changes. Please try again later.', retryAfter);
    const next = { ...rate, count: rate.count + 1, ips: { ...rate.ips, [hash]: used + 1 } };
    // R2 has no native TTL. The one bounded object discards expired hourly
    // hashes on the next change; only the HMAC, never the raw IP, is stored.
    if (await putIfUnchanged(bucket, RATE_KEY, next, object)) return;
  }
  throw new Failure(503, 'Reactions are temporarily busy. Please try again.', 5);
}
async function changeReaction(request, bucket, slug, voter, liked, mac, firstRead) {
  let current = firstRead;
  // Identical retries do not increment the count or spend another rate token.
  if (Object.hasOwn(current.state.voters, voter) === liked) return { count: current.state.count, liked };
  await reserveChange(request, bucket, mac);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (attempt > 0) current = await readState(bucket, slug);
    if (Object.hasOwn(current.state.voters, voter) === liked) return { count: current.state.count, liked };
    if (liked && current.state.count >= MAX_ACTIVE_VOTES) throw new Failure(503, 'This article cannot accept more reactions right now.');
    const voters = { ...current.state.voters };
    if (liked) voters[voter] = true; else delete voters[voter];
    const next = { version: 1, slug, count: current.state.count + (liked ? 1 : -1), voters };
    if (await putIfUnchanged(bucket, stateKey(slug), next, current.object)) return { count: next.count, liked };
  }
  throw new Failure(503, 'Reactions are temporarily busy. Please try again.', 5);
}

/** Counts only, for an already-authorized owner dashboard. This is not an HTTP route. */
export async function readReactionTotals(env, slugs) {
  if (!Array.isArray(slugs) || slugs.length > MAX_SLUGS || slugs.some(slug => !validSlug(slug))) throw new Failure(400, 'Supply at most 1,000 valid article slugs.');
  const unique = [...new Set(slugs)];
  if (!unique.length) return {};
  const bucket = bucketFor(env);
  await knownSlugs(bucket, unique);
  const totals = {};
  // Keep storage concurrency bounded even for a full article archive.
  for (let offset = 0; offset < unique.length; offset += 5) {
    const batch = await Promise.all(unique.slice(offset, offset + 5).map(async slug => [slug, (await readState(bucket, slug)).state.count]));
    for (const [slug, count] of batch) totals[slug] = count;
  }
  return totals;
}

/** Anonymous, first-party helpful votes. Unknown routes are left to the Worker. */
export async function handleArticleReactions(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
  if (path !== ENDPOINT && !path.startsWith(`${ENDPOINT}/`)) return null;
  try {
    if (!['GET', 'POST'].includes(request.method)) throw new Failure(405, 'Use GET or POST.');
    const slug = path.slice(ENDPOINT.length + 1);
    if (!validSlug(slug)) throw new Failure(404, 'Article not found.');
    let visitor = null, liked;
    if (request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) throw new Failure(403, 'Submit reactions from this website.');
      if (url.search) throw new Failure(400, 'Supply the reaction in the request body.');
      ({ visitor, liked } = await readPayload(request));
    } else {
      if ([...url.searchParams.keys()].some(key => key !== 'visitor') || url.searchParams.getAll('visitor').length > 1) throw new Failure(400, 'Invalid reaction query.');
      if (url.searchParams.has('visitor')) visitor = visitorToken(url.searchParams.get('visitor'));
    }
    const bucket = bucketFor(env, request.method === 'POST');
    const mac = visitor ? await hmacFor(env) : null;
    await knownSlugs(bucket, [slug]);
    const voter = visitor ? await mac(`article-reactions:v1:visitor:${slug}:${visitor}`) : null;
    const current = await readState(bucket, slug);
    if (request.method === 'GET') return response({ count: current.state.count, liked: voter !== null && Object.hasOwn(current.state.voters, voter) });
    return response(await changeReaction(request, bucket, slug, voter, liked, mac, current));
  } catch (error) {
    // Never log the browser token, request URL/query, IP, or storage error details.
    const status = error instanceof Failure ? error.status : 503;
    const message = error instanceof Failure ? error.message : 'Article reactions are temporarily unavailable. Please try again.';
    const headers = status === 405 ? { Allow: 'GET, POST' } : {};
    if (error?.retryAfter) headers['Retry-After'] = String(error.retryAfter);
    return response({ error: message }, status, headers);
  }
}

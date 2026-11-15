import { authorizeWriter } from './writerAuth.mjs';
import { readReactionTotals } from './articleReactions.mjs';
import fallbackArticles from '../client/src/data/article-index.json' with { type: 'json' };

const ARCHIVE_KEY = 'writing/archive-v1.json', SNAPSHOT_KEY = 'writing/dashboard-external-v1.json';
const PLATFORMS = ['devto', 'substack', 'medium'], MAX_ARTICLES = 1000, MAX_VIEWS = 1_000_000_000_000;
const BODY_LIMIT = 512 * 1024, SNAPSHOT_LIMIT = 2 * 1024 * 1024, DAY = 86_400_000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const timeZone = 'America/Toronto';
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_VIEWS;
const validSlug = value => typeof value === 'string' && value.length <= 200 && SLUG.test(value);
class Failure extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', Vary: 'Authorization, Cookie', ...extra,
  } });
}
function bucketFor(env) {
  if (!env?.BUCKET || ['get', 'put', 'list'].some(name => typeof env.BUCKET[name] !== 'function')) throw new Failure(503, 'Writing statistics storage is unavailable.');
  return env.BUCKET;
}
async function authorized(request, env) {
  if (await authorizeWriter(request, env)) return 'service';
  const id = request.headers.get('oai-authenticated-user-id')?.trim();
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  const owner = typeof env?.WRITING_OWNER_EMAIL === 'string' ? env.WRITING_OWNER_EMAIL.trim().toLowerCase() : '';
  // Sites injects both verified identity headers; neither is accepted alone.
  if (id && email && id.length <= 200 && !/[\s,\u0000-\u001f\u007f]/.test(id) &&
      /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(owner) && email === owner) return 'owner';
  if (id || email) throw new Failure(403, 'This writing dashboard is available only to its owner.');
  throw new Failure(401, 'Sign in with the owner’s ChatGPT account to open this dashboard.');
}
function mutation(request, mode) {
  const origin = request.headers.get('Origin');
  if ((origin !== null || mode !== 'service') && origin !== new URL(request.url).origin) throw new Failure(403, 'Submit statistics from this website.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Failure(415, 'Submit statistics as JSON.');
}
async function boundedJson(source, maximum, invalidStatus = 400) {
  const length = source.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Failure(invalidStatus === 400 ? 413 : invalidStatus, 'Statistics data exceeds its size limit.');
  const reader = source.body?.getReader();
  if (!reader) throw new Failure(invalidStatus, 'Statistics data is missing.');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Failure(invalidStatus === 400 ? 413 : invalidStatus, 'Statistics data exceeds its size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Failure(invalidStatus, 'Statistics data is not valid JSON.'); }
}
function timestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) throw new Failure(400, 'Use an ISO date or UTC timestamp for asOf.');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, value.length === 10 ? 10 : 19) !== value.slice(0, value.length === 10 ? 10 : 19) || milliseconds > now + 300_000 || milliseconds < Date.parse('2000-01-01')) throw new Failure(400, 'Use a real, nonfuture date for asOf.');
  return new Date(milliseconds).toISOString();
}
function sourceUrl(platform, value, slug) {
  let url;
  try { if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error(); url = new URL(value); } catch { throw new Failure(400, 'Use a valid HTTPS article URL.'); }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  const hostname = url.hostname;
  const allowed = platform === 'devto' ? hostname === 'dev.to' && url.pathname.replace(/\/$/, '') === `/dessygil/${slug}` :
    platform === 'substack' ? hostname.endsWith('.substack.com') && hostname !== '.substack.com' : hostname === 'medium.com' || hostname.endsWith('.medium.com');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname === '/' || !allowed) throw new Failure(400, `Use the article’s ${platform === 'substack' ? 'substack.com' : platform === 'medium' ? 'medium.com' : 'dev.to/dessygil'} HTTPS URL. Custom domains are not configured.`);
  url.search = ''; url.hash = ''; return url.href;
}
async function articlesFor(bucket) {
  const saved = await bucket.get(ARCHIVE_KEY);
  if (saved?.size > 6 * 1024 * 1024) throw new Error('Archive too large');
  const articles = saved ? (await saved.json())?.articles : fallbackArticles;
  if (!Array.isArray(articles) || articles.length > MAX_ARTICLES) throw new Error('Invalid archive');
  const seen = new Set();
  return articles.map(article => {
    if (!object(article) || !validSlug(article.slug) || seen.has(article.slug) || !Number.isSafeInteger(article.id) || article.id <= 0 || typeof article.title !== 'string' || article.title.length > 500 || article.sourceUrl !== `https://dev.to/dessygil/${article.slug}`) throw new Error('Invalid article metadata');
    seen.add(article.slug); return { id: article.id, slug: article.slug, title: article.title, sourceUrl: article.sourceUrl };
  });
}
function emptySnapshots() { return { version: 1, updatedAt: null, platforms: Object.fromEntries(PLATFORMS.map(platform => [platform, Object.create(null)])) }; }
function uniqueUrls(entries) {
  const seen = new Set();
  for (const entry of Object.values(entries)) {
    if (seen.has(entry.url)) throw new Failure(409, 'An external article URL is linked to more than one local article. Each platform URL can be counted only once.');
    seen.add(entry.url);
  }
}
function snapshots(value, now) {
  if (value === null) return emptySnapshots();
  if (!object(value) || value.version !== 1 || !object(value.platforms) || !onlyKeys(value.platforms, PLATFORMS)) throw new Error('Invalid stored statistics');
  const result = emptySnapshots();
  result.updatedAt = value.updatedAt === null ? null : timestamp(value.updatedAt, now);
  for (const platform of PLATFORMS) {
    const entries = value.platforms[platform] || {};
    if (!object(entries) || Object.keys(entries).length > MAX_ARTICLES) throw new Error('Invalid stored statistics');
    for (const [slug, row] of Object.entries(entries)) {
      if (!validSlug(slug) || !object(row) || !count(row.views)) throw new Error('Invalid stored statistics');
      result.platforms[platform][slug] = { views: row.views, asOf: timestamp(row.asOf, now), url: sourceUrl(platform, row.url, slug) };
    }
    uniqueUrls(result.platforms[platform]);
  }
  return result;
}
async function savedSnapshots(bucket, now) {
  const current = await bucket.get(SNAPSHOT_KEY);
  if (current?.size > SNAPSHOT_LIMIT) throw new Error('Stored statistics too large');
  try { return { current, value: snapshots(current ? await current.json() : null, now) }; }
  catch { throw new Error('Invalid stored statistics'); }
}
function manualImport(input, articles, now) {
  if (!object(input) || !onlyKeys(input, ['platform', 'asOf', 'articles']) || !PLATFORMS.includes(input.platform) || !Array.isArray(input.articles) || !input.articles.length || input.articles.length > MAX_ARTICLES) throw new Failure(400, 'Supply a platform, asOf date, and 1–1,000 article statistics.');
  const asOf = timestamp(input.asOf, now), known = new Set(articles.map(article => article.slug)), seen = new Set();
  const entries = input.articles.map(row => {
    if (!object(row) || !onlyKeys(row, ['slug', 'url', 'views']) || !known.has(row.slug) || seen.has(row.slug) || !count(row.views)) throw new Failure(400, 'Use each known article slug once and a nonnegative whole-number view count.');
    seen.add(row.slug); return { slug: row.slug, views: row.views, asOf, url: sourceUrl(input.platform, row.url, row.slug) };
  });
  return { platform: input.platform, asOf, entries };
}
async function mergeImport(bucket, imported, now) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { current, value } = await savedSnapshots(bucket, now);
    for (const entry of imported.entries) {
      const prior = value.platforms[imported.platform][entry.slug];
      if (prior && prior.asOf > entry.asOf) throw new Failure(409, 'A newer snapshot is already saved for an article. Refresh the dashboard before importing older statistics.');
      const { slug, ...row } = entry; value.platforms[imported.platform][slug] = row;
    }
    uniqueUrls(value.platforms[imported.platform]);
    if (Object.keys(value.platforms[imported.platform]).length > MAX_ARTICLES) throw new Failure(413, 'The statistics archive has reached its article limit.');
    value.updatedAt = new Date(now).toISOString();
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > SNAPSHOT_LIMIT) throw new Failure(413, 'The statistics archive exceeds its size limit.');
    if (current && (typeof current.etag !== 'string' || !current.etag)) throw new Error('Missing storage revision');
    let written;
    try { written = await bucket.put(SNAPSHOT_KEY, text, { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } }); }
    catch (error) { if (error?.status === 412 || error?.statusCode === 412 || error?.name === 'PreconditionFailed') continue; throw error; }
    if (written !== null && written !== undefined) return { ok: true, platform: imported.platform, imported: imported.entries.length, asOf: imported.asOf };
  }
  throw new Failure(503, 'Statistics are being updated. Please retry shortly.');
}
function dayAt(now) { const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(now)).map(({ type, value }) => [type, value])); return `${parts.year}-${parts.month}-${parts.day}`; }
function validDay(value) { return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
// These are calendar labels, not Toronto instants: UTC day stepping also works across DST changes.
function shiftDay(day, offset) { return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10); }
function daysBetween(from, to) { return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1; }
function dateSelection(parameters, now) {
  const seen = new Set();
  for (const [key] of parameters) {
    if (!['range', 'from', 'to', 'article'].includes(key) || seen.has(key)) throw new Failure(400, 'Use each supported date-range parameter only once.');
    seen.add(key);
  }
  const range = parameters.get('range') ?? '30d', today = dayAt(now), article = parameters.get('article');
  if (!['7d', '30d', '90d', 'all', 'custom'].includes(range)) throw new Failure(400, 'Choose 7d, 30d, 90d, all, or custom for the date range.');
  if (article !== null && !validSlug(article)) throw new Failure(400, 'Choose a known article slug.');
  let from, to = today;
  if (range === 'custom') {
    from = parameters.get('from'); to = parameters.get('to');
    if (!validDay(from) || !validDay(to) || from > to || to > today || daysBetween(from, to) > 3660) throw new Failure(400, 'Choose real, nonfuture from/to dates in order, covering no more than 3,660 inclusive Toronto days.');
  } else {
    if (parameters.has('from') || parameters.has('to')) throw new Failure(400, 'Use from and to only with the custom date range.');
    from = range === 'all' ? null : shiftDay(today, 1 - Number.parseInt(range, 10));
  }
  return { range, from, to, today, article };
}
function add(left, right) { const value = left + right; if (!Number.isSafeInteger(value)) throw new Error('Statistics exceed numeric limit'); return value; }
async function websiteStatistics(bucket, articles, selection) {
  const perArticle = Object.fromEntries(articles.map(article => [article.slug, 0]));
  const periodPerArticle = Object.fromEntries(articles.map(article => [article.slug, 0])), periodDays = new Map();
  const pathToSlug = new Map(articles.map(article => [`/writing/${article.slug}`, article.slug]));
  const { today } = selection, days = new Map(Array.from({ length: 30 }, (_, index) => [shiftDay(today, index - 29), 0]));
  const keys = [], seen = new Set(); let cursor, websiteSince = null, lastUpdated = null, unassignedWebsiteViews = 0;
  for (let page = 0; page < 10; page += 1) {
    const listing = await bucket.list({ prefix: 'analytics/', limit: 500, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(listing.objects) || listing.objects.length > 500) throw new Error('Invalid analytics listing');
    for (const entry of listing.objects) {
      const match = entry.key?.match(/^analytics\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) continue;
      const day = match[1];
      if (!validDay(day) || day > today || seen.has(entry.key)) throw new Error('Invalid analytics day');
      seen.add(entry.key); keys.push({ key: entry.key, day });
      if (keys.length > 3660) throw new Failure(503, 'The recorded website history needs an archive rollup before it can be displayed completely.');
    }
    if (!listing.truncated) break;
    if (typeof listing.cursor !== 'string' || !listing.cursor || listing.cursor === cursor || page === 9) throw new Error('Incomplete analytics listing');
    cursor = listing.cursor;
  }
  for (let offset = 0; offset < keys.length; offset += 20) {
    const batch = await Promise.all(keys.slice(offset, offset + 20).map(async item => ({ ...item, saved: await bucket.get(item.key) })));
    for (const { day, saved } of batch) {
      if (!saved || saved.size > 512 * 1024) throw new Error('Missing or oversized daily statistics');
      const value = await saved.json();
      if (!object(value) || value.version !== 1 || value.day !== day || !object(value.paths) || Object.keys(value.paths).length > 128) throw new Error('Invalid daily statistics');
      websiteSince = websiteSince === null || day < websiteSince ? day : websiteSince;
      const uploaded = saved.uploaded instanceof Date ? saved.uploaded.toISOString() : `${day}T00:00:00.000Z`;
      lastUpdated = lastUpdated === null || uploaded > lastUpdated ? uploaded : lastUpdated;
      for (const [path, counters] of Object.entries(value.paths)) {
        if (!object(counters) || !count(counters.pageview)) throw new Error('Invalid website view count');
        if (path === '(other)') unassignedWebsiteViews = add(unassignedWebsiteViews, counters.pageview);
        const slug = pathToSlug.get(path); if (!slug) continue;
        perArticle[slug] = add(perArticle[slug], counters.pageview);
        if (days.has(day)) days.set(day, add(days.get(day), counters.pageview));
        if ((selection.from === null || day >= selection.from) && day <= selection.to) {
          periodPerArticle[slug] = add(periodPerArticle[slug], counters.pageview);
          if (selection.article === null || selection.article === slug) periodDays.set(day, add(periodDays.get(day) || 0, counters.pageview));
        }
      }
    }
  }
  const from = selection.from ?? websiteSince ?? today, length = daysBetween(from, selection.to);
  if (length > 3660) throw new Failure(503, 'The recorded website history needs an archive rollup before its complete daily range can be displayed.');
  const totalWebsiteViews = Object.values(periodPerArticle).reduce((sum, views) => add(sum, views), 0);
  const period = {
    range: selection.range, from, to: selection.to, today, timeZone, websiteSince,
    includesUnrecordedDays: websiteSince === null || from < websiteSince, includesToday: selection.to === today,
    totalWebsiteViews, selectedArticle: selection.article,
    selectedArticleViews: selection.article === null ? totalWebsiteViews : periodPerArticle[selection.article],
    daily: Array.from({ length }, (_, index) => { const day = shiftDay(from, index); return { day, views: websiteSince === null || day < websiteSince ? null : periodDays.get(day) || 0 }; }),
  };
  return { perArticle, periodPerArticle, period, daily: [...days].map(([day, views]) => ({ day, views })), websiteSince, lastUpdated, unassignedWebsiteViews };
}
async function dashboard(env, bucket, articles, selection, now) {
  if (selection.article !== null && !articles.some(article => article.slug === selection.article)) throw new Failure(400, 'Choose a known article slug.');
  const [external, website, reactions] = await Promise.all([savedSnapshots(bucket, now), websiteStatistics(bucket, articles, selection), readReactionTotals(env, articles.map(article => article.slug))]);
  const rows = articles.map(article => {
    const sources = Object.fromEntries(PLATFORMS.map(platform => [platform, external.value.platforms[platform][article.slug] || null]));
    const likes = reactions[article.slug]; if (!count(likes)) throw new Error('Invalid reaction count');
    const websiteViews = website.perArticle[article.slug];
    return { slug: article.slug, title: article.title, sourceUrl: article.sourceUrl, websiteViews, periodWebsiteViews: website.periodPerArticle[article.slug], likes, ...sources, totalViews: PLATFORMS.reduce((total, platform) => add(total, sources[platform]?.views || 0), websiteViews) };
  });
  const totals = { websiteViews: rows.reduce((sum, row) => add(sum, row.websiteViews), 0), likes: rows.reduce((sum, row) => add(sum, row.likes), 0) };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const present = rows.map(row => row[platform]).filter(Boolean), dates = present.map(row => row.asOf).sort();
    totals[`${platform}Views`] = present.length ? present.reduce((sum, row) => add(sum, row.views), 0) : null;
    platforms[platform] = { reportedArticles: present.length, totalArticles: rows.length, earliestAsOf: dates[0] || null, latestAsOf: dates.at(-1) || null };
  }
  totals.reportedViews = rows.reduce((sum, row) => add(sum, row.totalViews), 0);
  return { articles: rows, totals, daily: website.daily, period: website.period, coverage: {
    websiteSince: website.websiteSince, lastUpdated: [external.value.updatedAt, website.lastUpdated].filter(Boolean).sort().at(-1) || null,
    generatedAt: new Date(now).toISOString(), websiteWindow: 'recorded-lifetime', dailyWindow: 'last-30-days', externalWindow: 'latest-reported-cumulative',
    timeZone, analyticsEnabled: env.ANALYTICS_ENABLED === 'true', unassignedWebsiteViews: website.unassignedWebsiteViews, platforms,
  } };
}
async function importDevto(input, env, articles, now) {
  if (!object(input) || !onlyKeys(input, ['apiKey'])) throw new Failure(400, 'Supply only an optional DEV.to API key.');
  const key = input.apiKey === undefined ? env.DEVTO_ANALYTICS_API_KEY : input.apiKey;
  if (key === undefined || key === '') throw new Failure(409, 'Enter your DEV.to API key to refresh private view counts, or configure it securely on the server.', 'devto_key_required');
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(key)) throw new Failure(400, 'Use a valid DEV.to API key.', 'devto_invalid_key');
  const signal = AbortSignal.timeout(25_000); let bytesRead = 0;
  async function read(path) {
    let response;
    // Workers supports follow/manual, not redirect:error. Manual prevents the
    // credential from being forwarded to a redirect destination; reject below.
    try { response = await fetch(`https://dev.to${path}`, { headers: { 'api-key': key, Accept: 'application/vnd.forem.api-v1+json', 'User-Agent': 'DesPersonalSite/1.0 (+https://desmondgilmour.com)' }, redirect: 'manual', signal }); }
    catch { throw new Failure(502, 'The website could not connect to DEV.to. This does not mean your API key is wrong. Saved counts are unchanged.', 'devto_connection_failed'); }
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      if (response.status === 401) throw new Failure(400, 'DEV.to did not accept this API key. Copy the key value from DEV.to Settings → Extensions.', 'devto_invalid_key');
      if (response.status === 403) throw new Failure(502, 'DEV.to blocked the website’s request. This does not establish that your API key is wrong.', 'devto_blocked');
      if (response.status === 429) throw new Failure(429, 'DEV.to is limiting requests. Wait a few minutes before importing again.', 'devto_rate_limited');
      throw new Failure(502, 'DEV.to statistics are temporarily unavailable. The saved counts are unchanged.', 'devto_unavailable');
    }
    let value;
    try { value = await boundedJson(response, 5 * 1024 * 1024, 502); }
    catch { throw new Failure(502, 'DEV.to returned an unreadable statistics response. Saved counts are unchanged.', 'devto_invalid_response'); }
    bytesRead += new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytesRead > 20 * 1024 * 1024) throw new Failure(502, 'DEV.to statistics exceed the import limit.', 'devto_invalid_response');
    return value;
  }
  const user = await read('/api/users/me');
  if (!object(user) || typeof user.username !== 'string') throw new Failure(502, 'DEV.to returned an invalid account response.', 'devto_invalid_response');
  if (user.username !== 'dessygil') throw new Failure(400, 'Use the DEV.to API key belonging to dessygil.', 'devto_account_mismatch');
  const known = new Map(articles.map(article => [article.slug, article])), seen = new Set(), entries = [];
  const asOf = new Date(now).toISOString();
  for (let page = 1; page <= 11; page += 1) {
    const batch = await read(`/api/articles/me/published?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw new Failure(502, 'DEV.to returned invalid article statistics.', 'devto_invalid_response');
    for (const item of batch) {
      if (!object(item) || !Number.isSafeInteger(item.id) || item.id <= 0 || !validSlug(item.slug) || seen.has(item.id) || item.user?.username !== 'dessygil' || !count(item.page_views_count)) throw new Failure(502, 'DEV.to returned invalid article statistics.', 'devto_invalid_response');
      seen.add(item.id); if (seen.size > MAX_ARTICLES) throw new Failure(502, 'DEV.to statistics exceed the article limit.', 'devto_invalid_response');
      const url = sourceUrl('devto', item.url, item.slug), article = known.get(item.slug);
      if (article) {
        if (article.id !== item.id || entries.some(entry => entry.slug === item.slug)) throw new Failure(502, 'DEV.to article identities did not match the writing archive.', 'devto_invalid_response');
        entries.push({ slug: item.slug, views: item.page_views_count, url, asOf });
      }
    }
    if (batch.length < 100) {
      if (!entries.length) throw new Failure(409, 'No matching published articles were found. Refresh the writing archive first.', 'devto_no_matching_articles');
      return { platform: 'devto', asOf, entries };
    }
  }
  throw new Failure(502, 'DEV.to pagination did not finish. The saved counts are unchanged.', 'devto_invalid_response');
}

/** Private dashboard endpoints only. Sites must strip client identity headers and inject its verified identity. */
export async function handleWritingDashboard(request, env) {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (!['/api/private/writing-dashboard', '/api/private/writing-stats', '/api/private/devto-stats'].includes(path)) return null;
  try {
    const mode = await authorized(request, env), expectedMethod = path === '/api/private/writing-dashboard' ? 'GET' : 'POST';
    if (request.method !== expectedMethod) return json({ error: `Use ${expectedMethod}.` }, 405, { Allow: expectedMethod });
    const now = Date.now(), selection = expectedMethod === 'GET' ? dateSelection(new URL(request.url).searchParams, now) : null;
    if (expectedMethod === 'POST') mutation(request, mode);
    const input = expectedMethod === 'POST' ? await boundedJson(request, path.endsWith('/devto-stats') ? 1024 : BODY_LIMIT) : null;
    const bucket = bucketFor(env), articles = await articlesFor(bucket);
    if (expectedMethod === 'GET') return json(await dashboard(env, bucket, articles, selection, now));
    const imported = path.endsWith('/devto-stats') ? await importDevto(input, env, articles, now) : manualImport(input, articles, now);
    return json(await mergeImport(bucket, imported, now));
  } catch (error) {
    // Do not log or reflect request contents, upstream errors, credentials, or storage details.
    const status = error instanceof Failure ? error.status : 503;
    const code = error instanceof Failure && error.code ? error.code : path === '/api/private/devto-stats' ? (status === 503 ? 'devto_storage_unavailable' : status === 409 ? 'devto_import_conflict' : null) : null;
    return json({ error: error instanceof Failure ? error.message : 'Writing statistics are temporarily unavailable.', ...(code ? { code } : {}) }, status);
  }
}

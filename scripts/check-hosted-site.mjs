import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sanitizeHtml from 'sanitize-html';

export const SITE_ORIGIN = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_INTERNAL = 350;
const MAX_EXTERNAL = 150;
const MAX_REQUESTS = 650;
const TIMEOUT_MS = 12000;
const RUN_TIMEOUT_MS = 240000;
const decode = value => String(value).replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const point = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd';
}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[n]));
const normalize = value => decode(value).replace(/\s+/g, ' ').trim();
const displayUrl = value => {
  const url = new URL(value);
  return `${url.origin}${url.pathname}${url.hash}`;
};

export function validateConfig(config) {
  if (!config || typeof config.url !== 'string' || typeof config.token !== 'string' ||
      !config.token || config.token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(config.token) ||
      (config.checkExternalLinks !== undefined && typeof config.checkExternalLinks !== 'boolean') ||
      (config.expectPublic !== undefined && typeof config.expectPublic !== 'boolean')) {
    throw new Error('Expected Site URL, service token, and optional boolean checkExternalLinks and expectPublic.');
  }
  let url;
  try { url = new URL(config.url); } catch { throw new Error('Expected a valid Site URL.'); }
  if (url.origin !== SITE_ORIGIN || url.username || url.password || url.search || url.hash) throw new Error('Site origin does not match this checker.');
  return { url: SITE_ORIGIN, token: config.token, checkExternalLinks: config.checkExternalLinks === true, expectPublic: config.expectPublic === true };
}

export function collectReferences(html, pageUrl) {
  const references = [];
  const ids = new Set();
  let visibleText = '';
  let hasHeading = false;
  let hasMain = false;
  let currentHeading = null;
  const headingTexts = [];
  const add = (value, kind) => {
    if (!value || value.length > 4096) return;
    try {
      const url = new URL(value, pageUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      references.push({ url: url.href, kind });
    } catch { /* Invalid URLs cannot be fetched. */ }
  };
  sanitizeHtml(html, {
    allowedTags: [], allowedAttributes: {},
    onOpenTag(tag, attributes) {
      if (attributes.id) ids.add(attributes.id);
      if (tag === 'a' && attributes.name) ids.add(attributes.name);
      if (tag === 'h1') { hasHeading = true; currentHeading = ''; }
      if (tag === 'main' && attributes.id === 'main') hasMain = true;
      if (tag === 'a') add(attributes.href, 'link');
      if (tag === 'img' || tag === 'source') {
        add(attributes.src, 'image');
        for (const candidate of (attributes.srcset || '').split(',').slice(0, 20)) add(candidate.trim().split(/\s+/)[0], 'image');
      }
      if (tag === 'script') add(attributes.src, 'asset');
      if (tag === 'link' && /(?:^|\s)(?:stylesheet|icon|preload)(?:\s|$)/i.test(attributes.rel || '')) add(attributes.href, 'asset');
    },
    onCloseTag(tag) {
      if (tag === 'h1' && currentHeading !== null) { headingTexts.push(normalize(currentHeading)); currentHeading = null; }
    },
    textFilter(text) { visibleText += `${text} `; if (currentHeading !== null) currentHeading += `${text} `; return text; },
  });
  return { references, ids, text: normalize(visibleText), hasHeading, hasMain, headingTexts };
}

export function publicExternalUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
        /^[\d.]+$/.test(host) || host.includes(':') ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || host.endsWith('.localdomain')) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

export function classifyExternalStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'broken';
  return 'unverified';
}

async function readBody(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY) { await response.body?.cancel(); throw new Error('Response exceeded the size limit.'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BODY) { await reader.cancel(); throw new Error('Response exceeded the size limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function checkHostedSite(input, { fetcher = fetch, now = () => Date.now() } = {}) {
  const config = validateConfig(input);
  const started = now();
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  const result = { ok: true, checked: { requests: 0, pages: 0, images: 0, assets: 0, externalLinks: 0, publicPages: 0 }, failures: [], warnings: [], sync: null, externalLinksRequested: config.checkExternalLinks, publicAccess: { expected: config.expectPublic, ok: null } };
  const issues = new Set();
  function issue(severity, kind, url, reason, status) {
    const safeUrl = displayUrl(url).replaceAll(config.token, '[REDACTED]');
    const id = `${severity}:${kind}:${safeUrl}:${reason}`;
    if (issues.has(id)) return;
    issues.add(id);
    result[severity].push({ kind, url: safeUrl, reason, ...(status ? { status } : {}) });
  }
  async function request(url, method = 'GET', external = false, anonymous = false) {
    if (result.checked.requests >= MAX_REQUESTS || Date.now() >= deadline) throw new Error('Check budget exhausted.');
    const target = new URL(url);
    if (external && (target.href.includes(config.token) || decodeURIComponent(target.href).includes(config.token))) throw new Error('Reflected credentials cannot be sent externally.');
    if (external ? !publicExternalUrl(target.href) || target.origin === SITE_ORIGIN : target.origin !== SITE_ORIGIN || target.username || target.password) throw new Error('Unsupported request target.');
    if (!external && target.pathname.startsWith('/api/') && !['/api/health', '/api/articles'].includes(target.pathname)) throw new Error('Unsupported API route.');
    result.checked.requests += 1;
    return fetcher(target.href, {
      method, redirect: external ? 'manual' : 'error', credentials: 'omit',
      signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, deadline - Date.now()))),
      headers: external ? { 'User-Agent': 'DesSiteLinkChecker/1.0' } : anonymous ? {} : { 'OAI-Sites-Authorization': `Bearer ${config.token}` },
    });
  }
  async function read(url, kind, contentTypes, anonymous = false) {
    try {
      const response = await request(url, 'GET', false, anonymous);
      if (!response.ok) { await response.body?.cancel(); issue('failures', kind, url, 'Site returned an unsuccessful response.', response.status); return null; }
      if (contentTypes && !contentTypes.some(type => (response.headers.get('content-type') || '').includes(type))) {
        await response.body?.cancel(); issue('failures', kind, url, 'Unexpected content type.'); return null;
      }
      return await readBody(response);
    } catch { issue('failures', kind, url, 'Site request failed, timed out, or exceeded a safety limit.'); return null; }
  }
  async function readJson(path) {
    const url = SITE_ORIGIN + path;
    const body = await read(url, 'api', ['application/json']);
    if (body === null) return null;
    try { return JSON.parse(body); } catch { issue('failures', 'api', url, 'Response was not valid JSON.'); return null; }
  }
  const health = await readJson('/api/health');
  if (!health || typeof health !== 'object') issue('failures', 'freshness', SITE_ORIGIN + '/api/health', 'Health response is missing or malformed.');
  if (health) {
    const synced = typeof health.lastSyncedAt === 'string' ? Date.parse(health.lastSyncedAt) : NaN;
    result.sync = { status: typeof health.status === 'string' ? health.status.slice(0, 60) : 'invalid', lastSyncedAt: Number.isFinite(synced) ? new Date(synced).toISOString() : null, articleCount: Number.isInteger(health.articleCount) ? health.articleCount : null };
    if (health.status !== 'ok' || !Number.isFinite(synced) || started - synced > 48 * 3600000 || synced - started > 5 * 60000) issue('failures', 'freshness', SITE_ORIGIN + '/api/health', 'Writing sync is not healthy or is more than 48 hours old.');
  }
  const archive = await readJson('/api/articles');
  const articles = Array.isArray(archive) ? archive.filter(article => article && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) && typeof article.title === 'string' && typeof article.bodyHtml === 'string') : [];
  if (!articles.length || articles.length !== archive?.length || articles.length > 1000) issue('failures', 'archive', SITE_ORIGIN + '/api/articles', 'Writing archive is missing or malformed.');
  if (health && health.articleCount !== articles.length) issue('failures', 'archive', SITE_ORIGIN + '/api/articles', 'Health count and archive count disagree.');
  const expected = new Map([[SITE_ORIGIN + '/', { title: 'Desmond Gilmour' }], [SITE_ORIGIN + '/writing', { title: 'articles' }]]);
  for (const article of articles.slice(0, 1000)) expected.set(`${SITE_ORIGIN}/writing/${article.slug}`, { title: article.title, article: true, bodyExcerpt: collectReferences(article.bodyHtml, SITE_ORIGIN).text.slice(0, 160) });
  if (config.expectPublic) {
    // Verify actual visitor access separately from the service-token checks.
    // Sample the home page, archive, and one full article without either auth header.
    for (const [url, requirement] of [...expected].slice(0, 3)) {
      result.checked.publicPages += 1;
      const html = await read(url, 'public-access', ['text/html'], true);
      if (html === null) continue;
      const parsed = collectReferences(html, url);
      if (!parsed.hasMain || !parsed.hasHeading || !parsed.text.includes(normalize(requirement.title)) ||
          (url === SITE_ORIGIN + '/' && !parsed.headingTexts.some(heading => heading.replace(/[^a-z]/gi, '').toLowerCase() === 'desmondgilmour')) ||
          (requirement.article && (!requirement.bodyExcerpt || !parsed.text.includes(requirement.bodyExcerpt) || !/class=["'][^"']*\barticle-prose\b/.test(html)))) {
        issue('failures', 'public-access', url, 'Anonymous visitors did not receive the expected website content; a sign-in gate or incomplete page may be present.');
      }
    }
    result.publicAccess.ok = !result.failures.some(failure => failure.kind === 'public-access');
  }
  const sitemap = await read(SITE_ORIGIN + '/sitemap.xml', 'sitemap', ['application/xml', 'text/xml']);
  if (sitemap !== null) {
    if (!/<urlset\b/.test(sitemap)) issue('failures', 'sitemap', SITE_ORIGIN + '/sitemap.xml', 'Sitemap root is missing.');
    const locations = [...sitemap.matchAll(/<loc>([^<]{1,4096})<\/loc>/g)].slice(0, 2000).map(match => decode(match[1]));
    for (const url of expected.keys()) if (!locations.includes(url)) issue('failures', 'sitemap', url, 'Required page is missing from the sitemap.');
    for (const location of locations) {
      try {
        const url = new URL(location);
        if (url.origin === SITE_ORIGIN && /^\/writing\/topics\/[a-z0-9-]+$/.test(url.pathname)) expected.set(url.href, { topic: true });
      } catch { issue('failures', 'sitemap', SITE_ORIGIN + '/sitemap.xml', 'Sitemap contains an invalid URL.'); }
    }
    if (articles.length && ![...expected.values()].some(page => page.topic)) issue('failures', 'sitemap', SITE_ORIGIN + '/sitemap.xml', 'Writing topic pages are missing from the sitemap.');
  }
  const feed = await read(SITE_ORIGIN + '/feed.xml', 'rss', ['application/rss+xml', 'application/xml', 'text/xml']);
  if (feed !== null) {
    if (!/<rss\b/.test(feed) || !/<channel>/.test(feed)) issue('failures', 'rss', SITE_ORIGIN + '/feed.xml', 'RSS channel is missing.');
    for (const article of articles) if (!feed.includes(`${SITE_ORIGIN}/writing/${article.slug}`)) issue('failures', 'rss', SITE_ORIGIN + '/feed.xml', `RSS is missing article ${article.slug}.`);
  }
  const internal = new Map([...expected].map(([url, requirement]) => [url, { kind: 'page', requirement }]));
  const external = new Set();
  const documents = new Map();
  const anchors = [];
  const visited = new Set();
  async function checkInternal(url, entry) {
    visited.add(url);
    if (entry.kind === 'image' || entry.kind === 'asset') {
      const body = await read(url, entry.kind, entry.kind === 'image' ? ['image/'] : null);
      result.checked[entry.kind === 'image' ? 'images' : 'assets'] += 1;
      if (body !== null && body.length === 0) issue('failures', entry.kind, url, 'Asset is empty.');
      return;
    }
    const html = await read(url, 'page', ['text/html']);
    result.checked.pages += 1;
    if (html === null) return;
    const parsed = collectReferences(html, url);
    documents.set(url, parsed);
    if (!parsed.hasHeading) issue('failures', 'page', url, 'Page has no rendered main heading.');
    if (entry.requirement?.title && !parsed.text.includes(normalize(entry.requirement.title))) issue('failures', 'page', url, 'Expected page title or introduction is absent from rendered content.');
    if (entry.requirement?.article && (!/class=["'][^"']*\barticle-prose\b/.test(html) || !entry.requirement.bodyExcerpt || !parsed.text.includes(entry.requirement.bodyExcerpt))) issue('failures', 'article', url, 'Full article content is absent.');
    for (const reference of parsed.references) {
      const target = new URL(reference.url);
      if (target.origin !== SITE_ORIGIN) { if (publicExternalUrl(target.href)) external.add(target.href.replace(/#.*$/, '')); continue; }
      if (target.pathname.startsWith('/api/') || target.pathname.startsWith('/automation/')) continue;
      if (target.hash) anchors.push({ target: target.origin + target.pathname + target.search, hash: target.hash.slice(1) });
      target.hash = '';
      if (['/feed.xml', '/sitemap.xml', '/robots.txt'].includes(target.pathname)) continue;
      if (!internal.has(target.href)) internal.set(target.href, { kind: reference.kind === 'link' ? 'page' : reference.kind });
    }
  }
  while (true) {
    const pending = [...internal].filter(([url]) => !visited.has(url)).slice(0, Math.max(0, MAX_INTERNAL - visited.size));
    if (!pending.length) break;
    for (let offset = 0; offset < pending.length; offset += 6) await Promise.all(pending.slice(offset, offset + 6).map(([url, entry]) => checkInternal(url, entry)));
  }
  if (internal.size > visited.size) issue('warnings', 'limit', SITE_ORIGIN, 'Internal check limit reached; some discovered URLs were not checked.');
  for (const anchor of anchors) {
    const document = documents.get(anchor.target);
    let id; try { id = decodeURIComponent(anchor.hash); } catch { id = anchor.hash; }
    if (document && !document.ids.has(id) && !id.startsWith(':~:text=')) issue('failures', 'anchor', `${anchor.target}#${anchor.hash}`, 'Linked section is missing.');
  }
  async function checkExternal(original) {
    result.checked.externalLinks += 1;
    let current = original;
    try {
      for (let hop = 0; hop < 4; hop += 1) {
        if (new URL(current).protocol !== 'https:') { issue('warnings', 'external', original, 'Plain HTTP destination was skipped; use HTTPS where available.'); return; }
        let response = await request(current, 'HEAD', true);
        if (response.status === 405 || response.status === 501) { await response.body?.cancel(); response = await request(current, 'GET', true); }
        const status = response.status;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (status >= 300 && status < 400 && location) {
          const next = publicExternalUrl(new URL(location, current).href);
          if (!next || next.origin === SITE_ORIGIN) break;
          current = next.href;
          continue;
        }
        const classification = classifyExternalStatus(status);
        if (classification !== 'ok') issue(classification === 'broken' ? 'failures' : 'warnings', 'external', original, classification === 'broken' ? 'External destination is confirmed missing.' : 'External destination could not be verified; it may block automated checks.', status);
        return;
      }
      issue('warnings', 'external', original, 'External redirect destination could not be safely verified.');
    } catch { issue('warnings', 'external', original, 'External destination could not be verified because of a network error, timeout, or check limit.'); }
  }
  if (config.checkExternalLinks) {
    const targets = [...external].slice(0, MAX_EXTERNAL);
    for (let offset = 0; offset < targets.length; offset += 6) await Promise.all(targets.slice(offset, offset + 6).map(checkExternal));
    if (external.size > targets.length) issue('warnings', 'limit', SITE_ORIGIN, 'External check limit reached; some discovered URLs were not checked.');
  }
  result.externalLinksDiscovered = external.size;
  result.ok = result.failures.length === 0;
  result.durationMs = Math.max(0, now() - started);
  return JSON.parse(JSON.stringify(result).replaceAll(config.token, '[REDACTED]'));
}

export async function main() {
  let settings;
  try {
    if (process.stdin.isTTY) {
      settings = execFileSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
      execFileSync('stty', ['-echo'], { stdio: 'inherit' });
    }
    console.log('Ready for Site access JSON on stdin (input is hidden).');
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let config;
    try {
      for await (const line of input) {
        if (line.length > 16384) throw new Error('Input exceeded the size limit.');
        try { config = JSON.parse(line); } catch { throw new Error('Expected valid Site access JSON.'); }
        break;
      }
    } finally {
      input.close();
      if (settings) { execFileSync('stty', [settings], { stdio: 'inherit' }); settings = undefined; }
    }
    const result = await checkHostedSite(config);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, checked: { requests: 0 }, failures: [{ kind: 'configuration', reason: 'Checker input was invalid or execution failed. No credentials were logged.' }], warnings: [] }));
    process.exitCode = 1;
  } finally {
    if (settings) { try { execFileSync('stty', [settings], { stdio: 'inherit' }); } catch { /* Already exiting. */ } }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

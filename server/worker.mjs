import { assets, template, snapshot } from './generated.mjs';
import { sanitizeBody } from './devto.mjs';
import { validateImport } from './importArchive.mjs';
import { authorizeWriter } from './writerAuth.mjs';
import { renderPage, sitemap, rss } from './pages.mjs';
import { findWritingTopic } from '../client/src/lib/writingTopics.js';
import { publicSiteConfig } from './runtimeConfig.mjs';
import { handleEngagement } from './engagement.mjs';
import { handleArticleReactions } from './articleReactions.mjs';
import { handleWritingDashboard } from './writingDashboard.mjs';

const key = 'writing/archive-v1.json';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function archive(env) {
  const object = await env.BUCKET?.get(key);
  if (!object) return { articles: snapshot, lastSyncedAt: null };
  const saved = await object.json();
  if (!saved || !Array.isArray(saved.articles) ||
      (saved.lastSyncedAt !== null && (typeof saved.lastSyncedAt !== 'string' || !Number.isFinite(Date.parse(saved.lastSyncedAt))))) {
    throw new Error('Stored writing archive is invalid.');
  }
  return saved;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const dashboard = await handleWritingDashboard(request, env);
    if (dashboard) return dashboard;
    const reactions = await handleArticleReactions(request, env);
    if (reactions) return reactions;
    const engagement = await handleEngagement(request, env);
    if (engagement) return engagement;
    if (path === '/api/sync-devto') {
      // Writer authentication is independent of the Site's visitor audience.
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (!await authorizeWriter(request, env)) return json({ error: 'Writer authorization required.' }, 401);
      if (request.headers.get('X-Des-Sync') !== 'devto-v1') return json({ error: 'Missing sync header.' }, 403);
      if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Cross-origin updates are disabled.' }, 403);
      if (!env.BUCKET) return json({ error: 'Writing storage is unavailable.' }, 503);
      try {
        const saved = await archive(env);
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Expected a JSON import from the cloud updater.' }, 400);
        const reader = request.body?.getReader();
        if (!reader) return json({ error: 'Missing import.' }, 400);
        const chunks = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 5 * 1024 * 1024) { await reader.cancel(); return json({ error: 'Import too large.' }, 413); } chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let payload, articles;
        try { payload = JSON.parse(new TextDecoder().decode(bytes)); articles = validateImport(payload, saved.articles); }
        catch { return json({ error: 'The import failed validation; the archive is unchanged.' }, 400); }
        if (payload.expectedLastSyncedAt !== saved.lastSyncedAt) return json({ error: 'Archive changed. Read it again and retry the import.' }, 409);
        const imported = articles.filter(article => !saved.articles.some(old => old.id === article.id)).length;
        const updated = articles.filter(article => saved.articles.some(old => old.id === article.id && JSON.stringify(old) !== JSON.stringify(article))).length;
        const record = { articles, imported, updated, lastSyncedAt: new Date().toISOString(), source: 'https://dev.to/dessygil' };
        // Keep the previous successful archive as a bounded recovery copy.
        if (saved.lastSyncedAt) await env.BUCKET.put('writing/previous-v1.json', JSON.stringify(saved), { httpMetadata: { contentType: 'application/json' } });
        await env.BUCKET.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
        return json({ status: 'synced', count: record.articles.length, imported: record.imported, updated: record.updated, lastSyncedAt: record.lastSyncedAt });
      } catch (error) {
        console.error('DEV.to synchronization failed:', error.message, error.cause?.message || '');
        return json({ error: 'DEV.to could not be synchronized. The saved archive is unchanged; retry later.' }, 502);
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    let saved;
    let archiveReadFailed = false;
    if (path.startsWith('/api/') || path === '/' || path === '/dashboard/writing' || path === '/writing' || path.startsWith('/writing/') || path === '/sitemap.xml' || path === '/feed.xml') {
      try { saved = await archive(env); } catch { saved = { articles: snapshot, lastSyncedAt: null }; archiveReadFailed = true; }
    }
    if (path === '/api/sync-status') return json({ count: saved.articles.length, lastSyncedAt: saved.lastSyncedAt, source: saved.source || 'https://dev.to/dessygil', imported: saved.imported ?? 0, updated: saved.updated ?? 0 });
    if (path === '/api/articles') return json(saved.articles);
    if (path.startsWith('/api/articles/')) {
      const article = saved.articles.find(item => path === `/api/articles/${item.slug}`);
      if (!article) return json({ error: 'Article not found.' }, 404);
      const { bodyMarkdown, ...detail } = article;
      return json(detail);
    }
    if (path === '/api/health') return json({ status: archiveReadFailed ? 'storage-unavailable' : env.BUCKET && saved.lastSyncedAt ? (Date.now() - Date.parse(saved.lastSyncedAt) < 48 * 3600000 ? 'ok' : 'sync-overdue') : 'awaiting-sync', articleCount: saved.articles.length, lastSyncedAt: saved.lastSyncedAt }, archiveReadFailed ? 503 : 200);
    if (path === '/sitemap.xml') return new Response(sitemap(saved.articles, url.origin), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    if (path === '/feed.xml') return new Response(rss(saved.articles, url.origin), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
    if (path === '/robots.txt') return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /automation/\nDisallow: /dashboard/\nSitemap: ${url.origin}/sitemap.xml\n`, { headers: { 'Content-Type': 'text/plain' } });
    const asset = assets[path];
    if (asset) {
      const decoded = atob(asset.data);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': asset.type, 'Cache-Control': path.startsWith('/static/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }
    const articles = saved?.articles || snapshot;
    const topicSlug = path.match(/^\/writing\/topics\/([^/]+)$/)?.[1];
    const found = path === '/' || path === '/writing' || path === '/dashboard/writing' || (topicSlug && findWritingTopic(articles, topicSlug)) || articles.some(item => path === `/writing/${item.slug}`);
    const html = renderPage(template, articles, path, url.origin, sanitizeBody, publicSiteConfig(env, url.origin), url.search);
    return new Response(request.method === 'HEAD' ? null : html, { status: found ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': path.startsWith('/dashboard/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': path.startsWith('/dashboard/') ? 'no-referrer' : 'strict-origin-when-cross-origin', ...(path.startsWith('/dashboard/') ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) } });
  }
};

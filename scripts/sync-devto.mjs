#!/usr/bin/env node
/**
 * Import all of dessygil's published DEV.to articles for the static website.
 * Node.js 24.5+: node --use-env-proxy scripts/sync-devto.mjs
 * No API key is required. Re-run to import newly published or edited articles.
 * JSON is replaced only after every article has been fetched successfully.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const username = 'dessygil';
const dataPath = join(root, 'client/src/data/articles.json');
const assetsPath = join(root, 'client/public/writing-assets');
const imageHosts = new Set([
  'media.dev.to', 'media2.dev.to', 'dev-to-uploads.s3.amazonaws.com',
  'res.cloudinary.com', 'images.unsplash.com',
]);
const imageTypes = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/gif', '.gif'],
  ['image/webp', '.webp'], ['image/avif', '.avif'],
]);

function permittedUrl(value, type) {
  const url = new URL(value);
  const allowed = type === 'api' ? url.hostname === 'dev.to' : imageHosts.has(url.hostname);
  if (!allowed || url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443')) {
    throw new Error(`Unsupported ${type} URL: ${url.origin}`);
  }
  if (type === 'api' && !url.pathname.startsWith('/api/articles')) {
    throw new Error('Only the public DEV.to articles API is permitted.');
  }
  return url;
}

async function fetchResource(value, type) {
  let url = permittedUrl(value, type);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'User-Agent': 'des-personal-site-importer/1.0',
          Accept: type === 'api' ? 'application/vnd.forem.api-v1+json' : 'image/*',
        },
      });
      if (![429, 502, 503, 504].includes(response.status) || attempt === 3) break;
      const retry = response.headers.get('retry-after');
      const milliseconds = retry
        ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now())
        : 1000 * (attempt + 1);
      await response.body?.cancel();
      if (!Number.isFinite(milliseconds) || milliseconds > 60_000) {
        throw new Error('DEV.to requested a longer retry delay. Re-run the import later.');
      }
      await delay(Math.max(1000, milliseconds));
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination = response.headers.get('location');
      await response.body?.cancel();
      if (!destination) throw new Error('Redirect without a destination.');
      url = permittedUrl(new URL(destination, url).href, type);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${type} request returned HTTP ${response.status}: ${url.pathname}`);
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0];
    if (type === 'image' && !imageTypes.has(contentType)) {
      await response.body?.cancel();
      throw new Error(`Image format ${contentType || '(unknown)'} is not copied.`);
    }
    const limit = type === 'api' ? 5 * 1024 * 1024 : 12 * 1024 * 1024;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error(`${type} resource exceeds the size limit.`);
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), contentType };
  }
  throw new Error('Too many redirects.');
}

async function fetchJson(url) {
  const response = await fetchResource(url, 'api');
  return JSON.parse(response.bytes.toString('utf8'));
}

function verifyAuthor(article) {
  if (article.user?.username !== username) {
    throw new Error(`Refusing article ${article.id}: unexpected author.`);
  }
}

function decodeAttribute(value) {
  return value.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
}

const copiedImages = new Map();
const externalImages = new Set();
async function localImage(value) {
  if (!value) return null;
  const decoded = decodeAttribute(value);
  if (copiedImages.has(decoded)) return copiedImages.get(decoded);
  try {
    permittedUrl(decoded, 'image');
    const response = await fetchResource(decoded, 'image');
    const digest = createHash('sha256').update(decoded).digest('hex').slice(0, 24);
    const filename = digest + imageTypes.get(response.contentType);
    await writeFile(join(assetsPath, filename), response.bytes);
    const localPath = '/writing-assets/' + filename;
    copiedImages.set(decoded, localPath);
    return localPath;
  } catch (error) {
    // Keep the original public URL and article text if an asset is unsupported.
    externalImages.add(decoded);
    console.warn(`Keeping an external image: ${error.message}`);
    copiedImages.set(decoded, value);
    return value;
  }
}

async function localizeHtml(html) {
  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)];
  const replacements = new Map();
  for (const match of imageTags) {
    const tag = match[0];
    const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (!src) continue;
    const local = await localImage(src[2]);
    if (!local?.startsWith('/writing-assets/')) continue;
    // Remove srcset so browsers use the imported image at every viewport size.
    const updated = tag.replace(src[0], `src="${local}"`)
      .replace(/\s+srcset\s*=\s*(["']).*?\1/gi, '');
    replacements.set(tag, updated);
  }
  for (const [before, after] of replacements) html = html.split(before).join(after);
  return html;
}

async function main() {
  await mkdir(dirname(dataPath), { recursive: true });
  await mkdir(assetsPath, { recursive: true });
  const summaries = new Map();
  let exhausted = false;
  for (let page = 1; page <= 100; page += 1) {
    const batch = await fetchJson(`https://dev.to/api/articles?username=${username}&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('DEV.to returned an invalid article list.');
    if (batch.length === 0) { exhausted = true; break; }
    let newCount = 0;
    for (const article of batch) {
      verifyAuthor(article);
      if (!Number.isSafeInteger(article.id)) throw new Error('Invalid article ID.');
      if (!summaries.has(article.id)) newCount += 1;
      summaries.set(article.id, article);
    }
    if (newCount === 0) throw new Error('DEV.to repeated a page; import was not completed.');
    await delay(300);
  }
  if (!exhausted) throw new Error('Pagination limit reached; existing article data was kept.');
  if (summaries.size === 0) throw new Error('No articles returned; existing article data was kept.');

  const articles = [];
  for (const summary of summaries.values()) {
    const article = await fetchJson(`https://dev.to/api/articles/${summary.id}`);
    verifyAuthor(article);
    if (article.id !== summary.id || typeof article.body_html !== 'string' ||
        !article.body_html.trim() || typeof article.body_markdown !== 'string' ||
        !/^[a-z0-9-]+$/.test(article.slug)) {
      throw new Error(`Incomplete article data for ${summary.id}.`);
    }
    const tags = Array.isArray(article.tags) ? article.tags
      : (typeof article.tag_list === 'string' ? article.tag_list.split(',').map(tag => tag.trim()) : article.tag_list || []);
    articles.push({
      id: article.id,
      slug: article.slug,
      title: article.title,
      description: article.description,
      sourceUrl: article.url,
      canonicalUrl: article.canonical_url || article.url,
      publishedAt: article.published_at || article.published_timestamp,
      updatedAt: article.edited_at || null,
      readingTimeMinutes: article.reading_time_minutes,
      tags,
      coverImage: await localImage(article.cover_image),
      originalCoverImage: article.cover_image || null,
      bodyHtml: await localizeHtml(article.body_html),
      bodyMarkdown: article.body_markdown,
      author: {
        name: article.user.name,
        username: article.user.username,
        profileUrl: `https://dev.to/${username}`,
      },
    });
    console.log(`Imported ${articles.length}/${summaries.size}: ${article.title}`);
    await delay(300);
  }
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  if (new Set(articles.map(article => article.slug)).size !== articles.length) {
    throw new Error('Duplicate article slugs would produce conflicting routes.');
  }
  const serialized = JSON.stringify(articles, null, 2) + '\n';
  const existing = await readFile(dataPath, 'utf8').catch(() => null);
  if (serialized !== existing) {
    const temporary = dataPath + '.tmp';
    await writeFile(temporary, serialized);
    await rename(temporary, dataPath);
  }
  console.log(JSON.stringify({ articles: articles.length, copiedImages: [...copiedImages.values()].filter(url => url.startsWith('/writing-assets/')).length, externalImages: externalImages.size, output: dataPath }));
}

main().catch(error => {
  console.error(`DEV.to import failed: ${error.message}`);
  process.exitCode = 1;
});

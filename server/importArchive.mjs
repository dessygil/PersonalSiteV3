import { sanitizeBody } from './devto.mjs';

const USERNAME = 'dessygil';
const PROFILE_URL = `https://dev.to/${USERNAME}`;
const MAX_ARTICLES = 1000;
const MAX_ARCHIVE_TEXT = 5_000_000;
const MAX_BODY = 500_000;
const localAsset = /^\/writing-assets\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|gif|webp|avif)$/;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function fail(message) {
  throw new TypeError(`Invalid writing import: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function text(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || controls.test(value) ||
      (!allowEmpty && !value.trim())) {
    fail(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${maximum} characters.`);
  }
  return value;
}

function date(value, label, optional = false) {
  if (optional && value === null) return null;
  const input = text(value, label, 40);
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(input))) fail(`${label} must be an ISO date.`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1000 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day || check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    fail(`${label} contains an invalid calendar date.`);
  }
  // Preserve the source spelling: incremental sync compares DEV.to edit dates.
  return input;
}

function webUrl(value, label, httpsOnly = false) {
  const input = text(value, label, 4096);
  let url;
  try { url = new URL(input); } catch { fail(`${label} must be an absolute URL.`); }
  if (!(httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) ||
      url.username || url.password) {
    fail(`${label} must use ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'} without credentials.`);
  }
  return url.href;
}

function cover(value, original) {
  if (value === null) return null;
  if (typeof value === 'string' && localAsset.test(value) && original?.coverImage === value) return value;
  return webUrl(value, 'coverImage', true);
}

function normalizeArticle(value, original) {
  const article = record(value, 'article');
  if (!Number.isSafeInteger(article.id) || article.id <= 0) fail('article ID must be a positive safe integer.');
  const slug = text(article.slug, 'slug', 200);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail('slug contains invalid characters.');
  const sourceUrl = `${PROFILE_URL}/${slug}`;
  if (article.sourceUrl !== sourceUrl) fail('sourceUrl must exactly match the author and slug on DEV.to.');
  const author = record(article.author, 'author');
  if (author.username !== USERNAME || author.profileUrl !== PROFILE_URL) fail('article author does not match dessygil.');
  if (!Array.isArray(article.tags) || article.tags.length > 10) fail('tags must be an array of at most 10 tags.');
  const tags = article.tags.map(value => {
    const tag = text(value, 'tag', 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(tag)) fail('tag contains invalid characters.');
    return tag;
  });
  if (new Set(tags).size !== tags.length) fail('tags must be unique.');
  if (!Number.isInteger(article.readingTimeMinutes) || article.readingTimeMinutes < 1 || article.readingTimeMinutes > 1440) {
    fail('readingTimeMinutes must be an integer from 1 to 1440.');
  }
  return {
    id: article.id,
    slug,
    title: text(article.title, 'title', 500),
    description: text(article.description, 'description', 5000, true),
    sourceUrl,
    canonicalUrl: webUrl(article.canonicalUrl, 'canonicalUrl'),
    publishedAt: date(article.publishedAt, 'publishedAt'),
    updatedAt: date(article.updatedAt, 'updatedAt', true),
    readingTimeMinutes: article.readingTimeMinutes,
    tags,
    coverImage: cover(article.coverImage, original),
    originalCoverImage: article.originalCoverImage === null ? null : webUrl(article.originalCoverImage, 'originalCoverImage', true),
    bodyHtml: text(article.bodyHtml, 'bodyHtml', MAX_BODY),
    bodyMarkdown: text(article.bodyMarkdown, 'bodyMarkdown', MAX_BODY),
    author: {
      name: text(author.name, 'author.name', 120),
      username: USERNAME,
      profileUrl: PROFILE_URL,
    },
  };
}

/**
 * Validate the cloud task's archive before a single durable write by the caller.
 * Returns a fresh, sanitized merge. Never writes storage or mutates either input.
 */
export function validateImport(payload, existing = []) {
  record(payload, 'payload');
  if (!Array.isArray(payload.articles) || payload.articles.length === 0 || payload.articles.length > MAX_ARTICLES) {
    fail(`articles must contain 1 to ${MAX_ARTICLES} entries.`);
  }
  if (!Array.isArray(existing) || existing.length > MAX_ARTICLES) fail('existing archive is invalid.');
  const original = new Map();
  for (const article of existing) {
    if (!article || original.has(article.id)) fail('existing archive contains duplicate IDs.');
    original.set(article.id, article);
  }
  const merged = new Map();
  for (const article of existing) {
    const normalized = normalizeArticle(article, article);
    merged.set(normalized.id, normalized);
  }
  const incomingIds = new Set();
  const incomingSlugs = new Set();
  for (const article of payload.articles) {
    const normalized = normalizeArticle(article, original.get(article?.id));
    if (incomingIds.has(normalized.id)) fail('incoming archive contains duplicate IDs.');
    if (incomingSlugs.has(normalized.slug)) fail('incoming archive contains duplicate slugs.');
    incomingIds.add(normalized.id);
    incomingSlugs.add(normalized.slug);
    merged.set(normalized.id, normalized);
  }
  const articles = [...merged.values()];
  if (articles.length > MAX_ARTICLES) fail('merged archive contains too many articles.');
  if (new Set(articles.map(article => article.slug)).size !== articles.length) fail('merged archive contains duplicate slugs.');
  const totalText = articles.reduce((total, article) => total + article.bodyHtml.length + article.bodyMarkdown.length, 0);
  if (totalText > MAX_ARCHIVE_TEXT) fail('combined article text exceeds the archive size limit.');
  return articles.map(article => {
    const bodyHtml = sanitizeBody(article.bodyHtml, articles);
    if (!bodyHtml.trim()) fail(`article ${article.id} has no safe readable content.`);
    return { ...article, bodyHtml };
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

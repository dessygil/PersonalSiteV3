import { createPageMetadata, SITE_NAME, WRITING_DESCRIPTION } from '../client/src/lib/siteMetadata.js';
import { getWritingTopics, topicSlug } from '../client/src/lib/writingTopics.js';
import { createArticleHeadings } from '../client/src/lib/articleHeadings.js';
import sanitizeHtml from 'sanitize-html';
import { renderProfile } from './render-pages.jsx';
import { normalizeSiteConfig } from '../client/src/lib/siteConfig.js';

export const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const e = escapeHtml;
const date = value => new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
export function metadata(articles, path, origin) {
  const meta = createPageMetadata({ articles, path, origin });
  const tags = [
    `<link rel="canonical" href="${e(meta.canonical)}"/>`,
    `<link rel="alternate" type="application/rss+xml" title="Writing by Desmond Gilmour" href="${e(meta.feedUrl)}"/>`,
    ...Object.entries({ ...meta.social, ...meta.articleMeta }).map(([name, value]) => `<meta ${/^(og|article):/.test(name) ? 'property' : 'name'}="${e(name)}" content="${e(value)}"/>`),
    ...(meta.noindex ? ['<meta name="robots" content="noindex, follow"/>'] : []),
    `<script type="application/ld+json" id="site-structured-data">${JSON.stringify(meta.schema).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}</script>`,
  ].join('');
  return { ...meta, tags };
}
function shell(content) {
  return `<a class="skip-to-content" href="#main">Skip to main content</a><header class="site-header"><nav class="site-nav" aria-label="Main navigation"><a class="brand" href="/"><span class="brand-mark">dg.</span><span>Desmond Gilmour</span></a><a class="text-link" href="/writing">Writing</a></nav></header><main class="site-main" id="main">${content}</main><footer class="site-footer"><a href="/">Desmond Gilmour</a><a href="/writing">All writing</a></footer>`;
}
function card(article) {
  return `<article class="article-card">${article.coverImage ? `<a tabindex="-1" aria-hidden="true" class="article-card-image" href="/writing/${e(article.slug)}"><img src="${e(article.coverImage)}" alt="" loading="lazy"/></a>` : ''}<div class="article-card-content"><p class="article-meta">${e(date(article.publishedAt))} · ${e(article.readingTimeMinutes)} min read</p><h3><a href="/writing/${e(article.slug)}">${e(article.title)}</a></h3><p class="article-excerpt">${e(article.description)}</p><a class="article-read-link" href="/writing/${e(article.slug)}">Read article →</a></div></article>`;
}

function articleOutline(safeHtml) {
  const records = [];
  const openHeadings = [];
  const reservedIds = [];
  // Use the sanitizer's parser for decoded heading text and legacy anchors.
  // Its output is discarded: safeHtml has already passed the article sanitizer.
  sanitizeHtml(safeHtml, {
    allowedTags: ['h2', 'h3', 'h4', 'h5', 'h6', 'a'],
    allowedAttributes: { '*': ['id'], a: ['id', 'name'] },
    onOpenTag(tag, attributes) {
      if (/^h[2-6]$/.test(tag)) {
        const record = { id: attributes.id || '', text: '', level: Number(tag[1]) };
        records.push(record);
        openHeadings.push(record);
      } else {
        if (attributes.id) reservedIds.push(attributes.id);
        if (tag === 'a' && attributes.name) {
          const heading = openHeadings[openHeadings.length - 1];
          if (heading && !heading.id) heading.id = attributes.name;
          else if (!heading && !attributes.id) reservedIds.push(attributes.name);
        }
      }
    },
    exclusiveFilter(frame) {
      if (/^h[2-6]$/.test(frame.tag)) {
        const index = openHeadings.findLastIndex(record => record.level === Number(frame.tag[1]));
        if (index >= 0) {
          openHeadings[index].text = frame.text.replace(/\s+/g, ' ').trim();
          openHeadings.splice(index, 1);
        }
      }
      return false;
    },
  });
  const headings = createArticleHeadings(records, reservedIds);
  let index = 0;
  // Sanitized heading tags have quoted, escaped attributes; text resembling
  // markup in code blocks is escaped and therefore cannot match this expression.
  const html = safeHtml.replace(/<h([2-6])\b([^>]*)>/g, (_, level, attributes) => {
    const heading = headings[index++];
    if (!heading) return `<h${level}${attributes}>`;
    return `<h${level}${attributes.replace(/\s+id="[^"]*"/g, '')} id="${e(heading.id)}">`;
  });
  const visible = headings.filter(heading => heading.text);
  const toc = visible.length ? `<nav class="article-toc" aria-label="On this page"><details open><summary>On this page</summary><ol>${visible.map(heading => `<li class="article-toc-level-${heading.level}"><a href="#${e(encodeURIComponent(heading.id))}">${e(heading.text)}</a></li>`).join('')}</ol></details></nav>` : '';
  return { html, toc };
}
export function renderPage(template, articles, path, origin, sanitizeBody = value => value, config = {}, search = '') {
  path = path.replace(/\/+$/, '') || '/';
  const meta = metadata(articles, path, origin);
  let content = path === '/' || (path.startsWith('/writing/topics/') && !meta.noindex) ? renderProfile(articles, path, normalizeSiteConfig(config), search, origin) : '';
  if (path === '/writing') content = shell(`<div class="writing-page"><header class="page-intro"><p class="eyebrow">THE NOTEBOOK</p><h1>Things I’ve learned.<br/>Things I’m exploring.</h1><p>Writing on biophysical science, chemistry, and building software.</p></header><h2>All ${articles.length} articles</h2><div class="article-grid archive-grid">${articles.map(card).join('')}</div></div>`);
  const article = articles.find(item => path === `/writing/${item.slug}`);
  if (article) {
    const outline = articleOutline(sanitizeBody(article.bodyHtml, articles));
    content = shell(`<div class="article-page"><a class="back-link" href="/writing">← All writing</a><article><header class="article-header"><div class="article-tags">${article.tags.map(tag => `<a href="/writing/topics/${e(topicSlug(tag))}">${e(tag)}</a>`).join('')}</div><h1 id="article-heading">${e(article.title)}</h1><p class="article-deck">${e(article.description)}</p><p class="article-meta">By Desmond Gilmour · <time datetime="${e(article.publishedAt)}">${e(date(article.publishedAt))}</time> · ${e(article.readingTimeMinutes)} min read</p></header>${article.coverImage ? `<img class="article-cover" src="${e(article.coverImage)}" alt=""/>` : ''}${outline.toc}<div class="article-prose">${outline.html}</div><footer class="article-source">Originally published on <a href="${e(article.sourceUrl)}">DEV.to</a>.</footer><section class="article-actions" aria-labelledby="article-actions-heading"><h2 id="article-actions-heading">Was this useful?</h2><p>Enable JavaScript to mark this article helpful or copy its link.</p><div class="article-share-row"><a class="article-action-button" href="https://www.linkedin.com/sharing/share-offsite/?url=${e(encodeURIComponent(new URL(`/writing/${article.slug}`, origin).href))}" target="_blank" rel="noopener noreferrer">Share on LinkedIn ↗</a></div><a class="text-link article-question-link" href="/?article=${e(encodeURIComponent(article.slug))}#Contact-anchor">Ask me about this article →</a></section></article></div>`);
  }
  if (meta.noindex) content = path === '/dashboard/writing'
    ? shell('<section class="page-intro"><p class="eyebrow">PRIVATE</p><h1>Writing dashboard</h1><p>Sign in with the site owner’s ChatGPT account to view writing statistics. JavaScript is required for this dashboard.</p><a class="text-link" target="_top" href="/signin-with-chatgpt?return_to=%2Fdashboard%2Fwriting">Sign in with ChatGPT →</a></section>')
    : shell('<section class="page-intro"><p class="eyebrow">404</p><h1>Page not found.</h1><p>This page may have moved. Explore the experience, projects, and writing on this site.</p><a class="text-link" href="/">Return home →</a></section>');
  const bootstrap = articles.map(({ bodyHtml, bodyMarkdown, ...summary }) => path === `/writing/${summary.slug}` ? { ...summary, bodyHtml } : summary);
  const data = JSON.stringify(bootstrap).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const siteConfig = JSON.stringify(normalizeSiteConfig(config)).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return template.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '').replace(/<title>[^<]*<\/title>/, () => `<title>${e(meta.title)}</title>`).replace(/<meta name="description" content="[^"]*"\s*\/?\s*>/, () => `<meta name="description" content="${e(meta.description)}"/>`).replace('</head>', () => `${meta.tags}<script>window.__SITE_CONFIG__=${siteConfig};</script><script>window.__WRITING_ARTICLES__=${data};</script></head>`).replace('<div id="root"></div>', () => `<div id="root">${content}</div>`);
}
export function sitemap(articles, origin) {
  const entries = [
    { path: '/' }, { path: '/writing' },
    ...getWritingTopics(articles).map(topic => ({ path: `/writing/topics/${topic.slug}` })),
    ...articles.map(item => ({ path: `/writing/${item.slug}`, modified: item.updatedAt || item.publishedAt })),
  ];
  const unique = [...new Map(entries.map(item => [item.path, item])).values()];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${unique.map(({ path, modified }) => `<url><loc>${xml(new URL(path, origin).href)}</loc>${validDate(modified) ? `<lastmod>${new Date(modified).toISOString()}</lastmod>` : ''}</url>`).join('')}</urlset>`;
}

const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const xml = value => e(String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ''));

// Excerpts send readers to the complete article while crediting its source.
export function rss(articles, origin) {
  const ordered = [...articles].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const modified = articles.map(item => item.updatedAt || item.publishedAt).filter(validDate).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const items = ordered.map(article => {
    const url = new URL(`/writing/${article.slug}`, origin).href;
    const excerpt = `${article.description || ''}\n\nOriginally published on DEV.to: ${article.sourceUrl}`;
    return `<item><title>${xml(article.title)}</title><link>${xml(url)}</link><guid isPermaLink="true">${xml(url)}</guid><description>${xml(excerpt)}</description>${validDate(article.publishedAt) ? `<pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate>` : ''}<dc:creator>${xml(SITE_NAME)}</dc:creator>${article.tags.map(tag => `<category>${xml(tag)}</category>`).join('')}<source url="https://dev.to/feed/dessygil">DEV.to — Desmond Gilmour</source></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Writing by ${xml(SITE_NAME)}</title><link>${xml(new URL('/writing', origin).href)}</link><description>${xml(WRITING_DESCRIPTION)}</description><language>en</language><atom:link href="${xml(new URL('/feed.xml', origin).href)}" rel="self" type="application/rss+xml"/>${modified ? `<lastBuildDate>${new Date(modified).toUTCString()}</lastBuildDate>` : ''}${items}</channel></rss>`;
}

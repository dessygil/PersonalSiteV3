import sanitizeHtml from "sanitize-html";

const AUTHOR = "dessygil";
const API_ORIGIN = "https://dev.to";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function validSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function publicUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

function ownedArticleLink(href, slugs) {
  if (!href || href.startsWith("#")) return href;
  try {
    const url = new URL(href, API_ORIGIN);
    if (url.origin !== API_ORIGIN) return href;
    const match = url.pathname.match(/^\/dessygil\/([^/]+)\/?$/);
    if (match && slugs.has(match[1])) return `/writing/${match[1]}${url.hash}`;
    // Relative links imported from DEV.to should still resolve to their source.
    if (href.startsWith("/") && !href.startsWith("/writing/")) return url.href;
  } catch {
    // sanitize-html removes unsafe schemes and malformed unsafe attributes.
  }
  return href;
}

/** Safe rich article HTML, without DEV.to-only code-block controls. */
export function sanitizeBody(html, articles = []) {
  const slugs = new Set(articles.map(article => typeof article === "string" ? article : article.slug));
  let result = sanitizeHtml(typeof html === "string" ? html : "", {
    allowedTags: [
      "a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "s", "del", "sub", "sup", "mark",
      "blockquote", "ul", "ol", "li", "pre", "code", "kbd", "div", "span",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
      "figure", "figcaption", "img", "details", "summary",
    ],
    allowedAttributes: {
      "*": ["class"],
      a: ["href", "name", "id", "title", "target", "rel"],
      h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      ol: ["start", "reversed"],
      li: ["value"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"],
      details: ["open"],
      pre: ["tabindex", "role", "aria-label"],
      table: ["tabindex"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
    exclusiveFilter(frame) {
      return (frame.attribs.class || "").split(/\s+/).includes("highlight__panel");
    },
    transformTags: {
      // Match client preparation: focus the actual CSS scroll containers only.
      // Imported focus order/roles never determine these controlled attributes.
      pre(tagName, attribs) {
        return { tagName, attribs: { ...attribs, tabindex: "0", role: "region", "aria-label": "Code block (scroll horizontally)" } };
      },
      table(tagName, attribs) {
        return { tagName, attribs: { ...attribs, tabindex: "0" } };
      },
      a(tagName, attribs) {
        const next = { ...attribs };
        if (next.href) next.href = ownedArticleLink(next.href, slugs);
        if (next.target === "_blank") next.rel = "noopener noreferrer";
        else delete next.target;
        return { tagName, attribs: next };
      },
      img(tagName, attribs) {
        return { tagName, attribs: { ...attribs, loading: "lazy" } };
      },
    },
  });
  // Match the client: the page title owns h1. Shift a post's heading hierarchy
  // once, after sanitization so escaped code cannot trigger normalization.
  if (/<h1(?:\s|>)/i.test(result)) {
    result = result.replace(/<(\/?)h([1-5])(?=[\s>])/gi,
      (_, closing, level) => `<${closing}h${Number(level) + 1}`);
  }
  return result;
}

function verifyAuthor(article) {
  if (!article || article.user?.username !== AUTHOR) {
    throw new Error("DEV.to returned an article from an unexpected author.");
  }
  if (!Number.isSafeInteger(article.id) || article.id <= 0) {
    throw new Error("DEV.to returned an invalid article ID.");
  }
}

function timestamp(value, field, optional = false) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`DEV.to returned an invalid ${field}.`);
  }
  return value;
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get("retry-after");
  const delay = header === null || header === undefined
    ? 400 * (attempt + 1)
    : (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now());
  if (!Number.isFinite(delay) || delay > 30_000) {
    throw new Error("DEV.to is rate-limited. Try syncing again later.");
  }
  return Math.max(0, delay);
}

async function readJson(response) {
  const declaredLength = Number(response.headers?.get("content-length"));
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("DEV.to response exceeded the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("DEV.to returned an empty response.");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("DEV.to response exceeded the size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("DEV.to returned invalid JSON.");
  }
}

async function fetchJson(path, fetcher) {
  // Paths are generated internally; article HTML and metadata never control requests.
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || !/^\/api\/articles(?:\/\d+)?$/.test(url.pathname)) {
    throw new Error("Invalid DEV.to API URL.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetcher(url.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/vnd.forem.api-v1+json" },
      });
    } catch (error) {
      if (attempt === 2) throw new Error("Unable to reach DEV.to. Existing articles were kept.", { cause: error });
      await wait(retryDelay(null, attempt));
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("DEV.to redirected its API response; sync was stopped.");
    }
    if (response.ok) return readJson(response);
    if (!RETRYABLE.has(response.status) || attempt === 2) {
      await response.body?.cancel();
      throw new Error(`DEV.to returned HTTP ${response.status}. Existing articles were kept.`);
    }
    const delay = retryDelay(response, attempt);
    await response.body?.cancel();
    await wait(delay);
  }
  throw new Error("DEV.to sync did not complete.");
}

function toArticle(article) {
  if (!validSlug(article.slug) || typeof article.title !== "string" || !article.title.trim() ||
      typeof article.body_html !== "string" || !article.body_html.trim() ||
      typeof article.body_markdown !== "string") {
    throw new Error(`DEV.to returned incomplete content for article ${article.id}.`);
  }
  const sourceUrl = `https://dev.to/${AUTHOR}/${article.slug}`;
  const tags = Array.isArray(article.tags) ? article.tags
    : Array.isArray(article.tag_list) ? article.tag_list
      : typeof article.tag_list === "string" ? article.tag_list.split(",").map(tag => tag.trim()) : [];
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    description: typeof article.description === "string" ? article.description : "",
    sourceUrl,
    canonicalUrl: publicUrl(article.canonical_url) || sourceUrl,
    publishedAt: timestamp(article.published_at || article.published_timestamp, "publication date"),
    updatedAt: timestamp(article.edited_at, "edit date", true),
    readingTimeMinutes: Number.isFinite(article.reading_time_minutes) ? Math.max(1, article.reading_time_minutes) : 1,
    tags: tags.filter(tag => typeof tag === "string" && tag.length > 0),
    coverImage: publicUrl(article.cover_image),
    originalCoverImage: publicUrl(article.cover_image),
    bodyHtml: article.body_html,
    bodyMarkdown: article.body_markdown,
    author: {
      name: typeof article.user.name === "string" ? article.user.name : "Desmond Gilmour",
      username: AUTHOR,
      profileUrl: `https://dev.to/${AUTHOR}`,
    },
  };
}

/**
 * Fetch and merge published DEV.to posts without writing storage or mutating input.
 * The caller should persist the returned archive only after this promise resolves.
 */
export async function syncDevto({ existing = [], fetcher = fetch } = {}) {
  if (!Array.isArray(existing) || typeof fetcher !== "function") {
    throw new TypeError("syncDevto requires an article array and a fetch function.");
  }
  const merged = new Map();
  for (const article of existing) {
    if (!Number.isSafeInteger(article?.id) || article.id <= 0 || !validSlug(article.slug) || merged.has(article.id)) {
      throw new Error("Existing archive contains an invalid or duplicate article.");
    }
    merged.set(article.id, article);
  }

  const summaries = new Map();
  let exhausted = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchJson(`/api/articles?username=${AUTHOR}&per_page=${PAGE_SIZE}&page=${page}`, fetcher);
    if (!Array.isArray(batch)) throw new Error("DEV.to returned an invalid article list.");
    if (batch.length === 0) { exhausted = true; break; }
    let added = 0;
    for (const summary of batch) {
      verifyAuthor(summary);
      timestamp(summary.edited_at, "edit date", true);
      if (!summaries.has(summary.id)) added += 1;
      summaries.set(summary.id, summary);
    }
    if (added === 0) throw new Error("DEV.to repeated a page; sync was stopped.");
  }
  if (!exhausted) throw new Error("DEV.to pagination limit reached; sync was stopped.");

  let imported = 0;
  let updated = 0;
  for (const summary of summaries.values()) {
    const old = merged.get(summary.id);
    const sourceEditedAt = summary.edited_at || null;
    if (old && (old.updatedAt || null) === sourceEditedAt) continue;
    const article = await fetchJson(`/api/articles/${summary.id}`, fetcher);
    verifyAuthor(article);
    if (article.id !== summary.id) throw new Error("DEV.to returned a mismatched article ID.");
    merged.set(article.id, toArticle(article));
    if (old) updated += 1;
    else imported += 1;
  }

  const articles = [...merged.values()];
  if (new Set(articles.map(article => article.slug)).size !== articles.length) {
    throw new Error("DEV.to article slugs conflict with the stored archive.");
  }
  const sanitized = articles.map(article => ({
    ...article,
    bodyHtml: sanitizeBody(article.bodyHtml, articles),
  })).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { articles: sanitized, imported, updated, sourceCount: summaries.size };
}

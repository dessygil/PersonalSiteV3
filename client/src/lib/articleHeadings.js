const pageIds = ["article-heading", "article-toc-heading", "article-actions-heading", "article-helpful-count", "article-share-link", "continue-reading", "main"];

function headingSlug(text) {
  return String(text || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

// Accept plain records so browser and server renderers generate identical anchors.
export function createArticleHeadings(records, reservedIds = []) {
  const used = new Set([...pageIds, ...reservedIds]);
  const existing = new Set(records.map(record => String(record.id || "").trim()).filter(Boolean));
  return records.map(record => {
    const original = String(record.id || "").trim();
    const base = original || headingSlug(record.text);
    let id = base;
    let suffix = 2;
    while (used.has(id) || (id !== original && existing.has(id))) id = `${base}-${suffix++}`;
    used.add(id);
    return { ...record, id };
  });
}

export function formatDate(value) {
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}
export function filterArticles(articles, query, topic) {
  const text = query.trim().toLowerCase();
  return articles.filter(article => (topic === "all" || article.tags.includes(topic)) && (!text || [article.title, article.description, ...article.tags].join(" ").toLowerCase().includes(text)));
}

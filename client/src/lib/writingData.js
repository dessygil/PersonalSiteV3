import snapshot from "../data/article-index.json";

// The server supplies its durable archive before the application starts.
// Local/static builds keep the checked-in snapshot for offline development.
const articles = typeof window !== "undefined" && Array.isArray(window.__WRITING_ARTICLES__)
  ? window.__WRITING_ARTICLES__ : snapshot;
export default articles;

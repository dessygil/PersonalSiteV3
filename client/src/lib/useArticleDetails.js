import { useEffect, useState } from "react";
import articles from "./writingData";

const cache = new Map(articles.filter(article => article.bodyHtml).map(article => [article.slug, article]));
export default function useArticleDetails(slug) {
  const listed = articles.find(article => article.slug === slug);
  const [loaded, setLoaded] = useState(() => cache.get(slug));
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setFailure(null);
    if (!listed || cache.has(slug)) { setLoaded(cache.get(slug)); return () => controller.abort(); }
    async function load() {
      let detail;
      try {
        const response = await fetch(`/api/articles/${encodeURIComponent(slug)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Article unavailable");
        detail = await response.json();
        if (detail.slug !== slug || typeof detail.bodyHtml !== "string") throw new Error("Invalid article response");
      } catch (error) {
        if (controller.signal.aborted) return;
        // Standalone static builds retain an on-demand article snapshot.
        const snapshot = await import("../data/articles.json");
        detail = snapshot.default.find(article => article.slug === slug);
        if (!detail) throw error;
      }
      cache.set(slug, detail);
      if (active) setLoaded(detail);
    }
    load().catch(() => { if (active) setFailure(slug); });
    return () => { active = false; controller.abort(); };
  }, [slug, listed]);
  const article = loaded?.slug === slug ? loaded : cache.get(slug) || listed;
  return { article, loading: !!article && !article.bodyHtml && failure !== slug, failed: failure === slug };
}

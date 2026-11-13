import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import articles from "./writingData";
import { createPageMetadata } from "./siteMetadata";

function updateMeta(name, value) {
  const attribute = /^(og|article):/.test(name) ? "property" : "name";
  let element = document.head.querySelector(`meta[${attribute}="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, name);
    document.head.appendChild(element);
  }
  element.content = value;
}

export default function PageMetadata() {
  const { pathname } = useLocation();
  useEffect(() => {
    const meta = createPageMetadata({ articles, path: pathname, origin: window.location.origin });
    document.title = meta.title;
    updateMeta("description", meta.description);
    Object.entries(meta.social).forEach(([name, value]) => updateMeta(name, value));
    document.head.querySelectorAll('meta[property^="article:"]').forEach(element => element.remove());
    Object.entries(meta.articleMeta).forEach(([name, value]) => updateMeta(name, value));
    if (meta.noindex) updateMeta("robots", "noindex, follow");
    else document.head.querySelector('meta[name="robots"]')?.remove();

    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement("link"); canonical.rel = "canonical"; document.head.appendChild(canonical); }
    canonical.href = meta.canonical;
    let feed = document.head.querySelector('link[rel="alternate"][type="application/rss+xml"]');
    if (!feed) { feed = document.createElement("link"); feed.rel = "alternate"; feed.type = "application/rss+xml"; document.head.appendChild(feed); }
    feed.title = "Writing by Desmond Gilmour";
    feed.href = meta.feedUrl;

    let schema = document.getElementById("site-structured-data");
    if (!schema) { schema = document.createElement("script"); schema.id = "site-structured-data"; schema.type = "application/ld+json"; document.head.appendChild(schema); }
    schema.textContent = JSON.stringify(meta.schema);
  }, [pathname]);
  return null;
}

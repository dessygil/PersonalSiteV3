import usePageNavigation from "../../lib/usePageNavigation";
import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DOMPurify from "dompurify";
import articles from "../../lib/writingData";
import { formatDate } from "../../lib/writing";
import useArticleDetails from "../../lib/useArticleDetails";
import { createArticleHeadings } from "../../lib/articleHeadings";
import { topicSlug } from "../../lib/writingTopics";
export function prepareArticleContent(html) {
  const fragment = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button", "iframe", "video", "audio"], FORBID_ATTR: ["style", "srcdoc", "srcset", "tabindex"], RETURN_DOM_FRAGMENT: true });
  fragment.querySelectorAll(".highlight__panel").forEach(panel => panel.remove());
  // Imported posts sometimes begin their own heading hierarchy at h1.
  // Keep the article title as the page's only h1 without changing the text.
  if (fragment.querySelector("h1")) {
    fragment.querySelectorAll("h1,h2,h3,h4,h5").forEach(heading => {
      const replacement = document.createElement(`h${Number(heading.tagName.slice(1)) + 1}`);
      Array.from(heading.attributes).forEach(attribute => replacement.setAttribute(attribute.name, attribute.value));
      replacement.append(...Array.from(heading.childNodes));
      heading.replaceWith(replacement);
    });
  }
  fragment.querySelectorAll("a[name]").forEach(anchor => {
    const heading = anchor.closest("h1,h2,h3,h4,h5,h6");
    const target = heading || anchor;
    if (!target.id) target.id = anchor.getAttribute("name");
  });
  const headingElements = [...fragment.querySelectorAll("h2,h3,h4,h5,h6")];
  const reservedIds = [...fragment.querySelectorAll("[id]")].filter(element => !headingElements.includes(element)).map(element => element.id);
  const headings = createArticleHeadings(headingElements.map(heading => ({ id: heading.id, text: heading.textContent.replace(/\s+/g, " ").trim(), level: Number(heading.tagName.slice(1)) })), reservedIds);
  headingElements.forEach((heading, index) => { heading.id = headings[index].id; });
  // These elements are the horizontal scroll containers in article CSS.
  // Use a normal tab stop, never a focus order supplied by imported HTML.
  fragment.querySelectorAll("pre, table").forEach(element => element.setAttribute("tabindex", "0"));
  fragment.querySelectorAll("pre").forEach(block => {
    block.setAttribute("role", "region");
    block.setAttribute("aria-label", "Code block (scroll horizontally)");
    block.removeAttribute("aria-labelledby");
  });
  // Keep the table's native semantics and caption as its accessible name.
  fragment.querySelectorAll("table").forEach(table => {
    ["role", "aria-label", "aria-labelledby"].forEach(attribute => table.removeAttribute(attribute));
  });
  fragment.querySelectorAll("img").forEach(img => img.setAttribute("loading", "lazy"));
  fragment.querySelectorAll("a[href]").forEach(link => {
    const target = articles.find(item => item.sourceUrl === link.getAttribute("href"));
    if (target) link.setAttribute("href", `/writing/${target.slug}`);
    if (link.getAttribute("target") === "_blank") link.setAttribute("rel", "noopener noreferrer");
  });
  const container = document.createElement("div");
  container.appendChild(fragment);
  return { html: container.innerHTML, headings: headings.filter(heading => heading.text) };
}
export function sanitizeArticle(html) {
  return prepareArticleContent(html).html;
}
export default function Article() {
  const { slug } = useParams();
  const { article, loading, failed } = useArticleDetails(slug);
  usePageNavigation(!!article?.bodyHtml);
  const { html, headings } = useMemo(() => article?.bodyHtml ? prepareArticleContent(article.bodyHtml) : { html: "", headings: [] }, [article]);
  const [coverError, setCoverError] = useState(false);
  useEffect(() => setCoverError(false), [article?.coverImage]);
  if (!article) return <section className="page-intro"><p className="eyebrow">WRITING</p><h1>Article not found.</h1><p>Explore the archive to find what you’re looking for.</p><Link className="text-link" to="/writing">Back to all writing →</Link></section>;
  const related = articles.filter(item => item.id !== article.id).sort((a, b) => b.tags.filter(tag => article.tags.includes(tag)).length - a.tags.filter(tag => article.tags.includes(tag)).length).slice(0, 2);
  return (
    <div className="article-page">
      <Link className="back-link" to="/writing"><span aria-hidden="true">← </span>All writing</Link>
      <article aria-labelledby="article-heading">
        <header className="article-header">
          <div className="article-tags">{article.tags.map(tag => <Link key={tag} to={`/writing/topics/${topicSlug(tag)}`}>{tag}</Link>)}</div>
          <h1 id="article-heading">{article.title}</h1>
          <p className="article-deck">{article.description}</p>
          <div className="article-byline">
            <span className="article-author-mark" aria-hidden="true">dg.</span>
            <div><p className="article-author">Desmond Gilmour</p><p className="article-meta"><time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time><span aria-hidden="true"> · </span><span>{article.readingTimeMinutes} min read</span></p></div>
          </div>
        </header>
        {article.coverImage && !coverError && <figure className="article-cover-frame"><img className="article-cover" src={article.coverImage} alt="" decoding="async" onError={() => setCoverError(true)} /></figure>}
        {loading && <p className="page-status" role="status">Loading article…</p>}
        {failed && <p role="alert">This article could not be loaded. <a className="text-link" href={article.sourceUrl}>Read it on DEV.to ↗</a></p>}
        {headings.length > 0 && <nav className="article-toc" aria-label="On this page"><details open><summary>On this page</summary><ol>{headings.map(heading => <li key={heading.id} className={`article-toc-level-${heading.level}`}><Link to={`#${encodeURIComponent(heading.id)}`}>{heading.text}</Link></li>)}</ol></details></nav>}
        <div className="article-prose" dangerouslySetInnerHTML={{ __html: html }} />
        <footer className="article-source"><span className="article-source-label">From the archive</span><p>Originally published on <a href={article.sourceUrl}>DEV.to</a>. Thanks for reading.</p></footer>
      </article>
      <aside className="related-writing" aria-labelledby="continue-reading">
        <p className="eyebrow">A LITTLE MORE TO EXPLORE</p><h2 id="continue-reading">Keep reading.</h2>
        {related.map(item => <Link key={item.id} to={`/writing/${item.slug}`}><span><span className="related-meta">{item.readingTimeMinutes} min read</span>{item.title}</span><span className="related-arrow" aria-hidden="true">↗</span></Link>)}
      </aside>
    </div>
  );
}

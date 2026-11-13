import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import defaultArticles from "../../lib/writingData";
import { findWritingTopic, getWritingTopics } from "../../lib/writingTopics";
import { filterArticles } from "../../lib/writing";
import usePageNavigation from "../../lib/usePageNavigation";
import ArticleCard from "../../components/shared/ArticleCard";

export default function Topic({ articles = defaultArticles }) {
  usePageNavigation();
  const { slug } = useParams();
  const topic = findWritingTopic(articles, slug);
  const [search, setSearch] = useState({ slug, query: "" });
  const query = search.slug === slug ? search.query : "";
  if (!topic) return <section className="page-intro"><p className="eyebrow">WRITING</p><h1>Topic not found.</h1><p>Browse the writing archive to find a topic.</p><Link className="text-link" to="/writing">Back to all writing <span aria-hidden="true">→</span></Link></section>;
  const filtered = filterArticles(topic.articles, query, "all");
  const relatedTopics = getWritingTopics(topic.articles).filter(item => item.slug !== topic.slug).slice(0, 6);
  return (
    <div className="writing-page topic-page">
      <Link className="back-link" to="/writing"><span aria-hidden="true">← </span>All writing</Link>
      <header className="page-intro topic-intro"><p className="eyebrow">EXPLORE A TOPIC</p><h1>{topic.title}</h1><p>Articles tagged <strong>{topic.tag}</strong>, collected in one place.</p><span className="writing-intro-note">{topic.articles.length} {topic.articles.length === 1 ? "article" : "articles"} · Read every story in full here</span></header>
      <div className="writing-controls" role="search" aria-label={`Find an article in ${topic.title}`}><div className="search-field"><label htmlFor="topic-search">Search {topic.title} articles</label><div className="search-input-wrap"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg><input id="topic-search" type="search" value={query} placeholder="Search within this topic…" onChange={event => setSearch({ slug, query: event.target.value })} /></div></div></div>
      <section aria-labelledby="topic-articles-heading">
        <div className="archive-heading"><h2 id="topic-articles-heading">{query.trim() ? "Search results" : `Writing on ${topic.title}`}</h2><p className="results-count" role="status">{filtered.length} {filtered.length === 1 ? "article" : "articles"}</p>{query.trim() && filtered.length > 0 && <button className="clear-filter-link" type="button" onClick={() => setSearch({ slug, query: "" })}>Clear search</button>}</div>
        <div className="article-grid archive-grid">{filtered.map(article => <ArticleCard key={article.id} article={article} />)}</div>
        {!filtered.length && <div className="empty-state"><h2>No articles found.</h2><p>Try another search within this topic.</p><button className="primary-link" type="button" onClick={() => setSearch({ slug, query: "" })}>Clear search</button></div>}
      </section>
      {relatedTopics.length > 0 && <nav className="writing-topic-navigation topic-related" aria-labelledby="related-topics-heading"><h2 id="related-topics-heading">Related topics</h2><ul className="writing-topic-links">{relatedTopics.map(item => <li key={item.slug}><Link to={`/writing/topics/${item.slug}`}>{item.title}</Link></li>)}</ul></nav>}
    </div>
  );
}

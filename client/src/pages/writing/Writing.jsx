import usePageNavigation from "../../lib/usePageNavigation";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import articles from "../../lib/writingData";
import ArticleCard from "../../components/shared/ArticleCard";
import { filterArticles } from "../../lib/writing";
import { getWritingTopics } from "../../lib/writingTopics";

export default function Writing() {
  usePageNavigation();
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("all");
  const topics = [...new Set(articles.flatMap(article => article.tags))].sort();
  const collections = getWritingTopics(articles);
  const filtered = filterArticles(articles, query, topic);
  const hasFilters = query.trim() || topic !== "all";
  const clearFilters = () => { setQuery(""); setTopic("all"); };

  return (
    <div className="writing-page">
      <header className="page-intro writing-intro">
        <p className="eyebrow">THE NOTEBOOK</p>
        <h1>Things I’ve learned.<br /><span className="muted">Things I’m exploring.</span></h1>
        <p>Notes on biophysical science, chemistry, and building software. Explore the ideas, experiments, and questions behind my work.</p>
        <span className="writing-intro-note">{articles.length} articles · Read every story in full here</span>
      </header>
      <nav className="writing-topic-navigation" aria-labelledby="writing-topics-heading">
        <h2 id="writing-topics-heading">Explore a topic</h2>
        <ul className="writing-topic-links">{collections.slice(0, 8).map(collection => <li key={collection.slug}><Link to={`/writing/topics/${collection.slug}`}>{collection.title}<span>{collection.articles.length}</span></Link></li>)}</ul>
        {collections.length > 8 && <details className="writing-more-topics"><summary>More topics</summary><ul className="writing-topic-links">{collections.slice(8).map(collection => <li key={collection.slug}><Link to={`/writing/topics/${collection.slug}`}>{collection.title}<span>{collection.articles.length}</span></Link></li>)}</ul></details>}
      </nav>
      <div className="writing-controls" role="search" aria-label="Find an article">
        <div className="search-field">
          <label htmlFor="article-search">Search the archive</label>
          <div className="search-input-wrap">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>
            <input id="article-search" type="search" placeholder="Try protein stability or Python…" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
        </div>
        <div className="topic-field">
          <label htmlFor="article-topic">Topic</label>
          <select id="article-topic" value={topic} onChange={event => setTopic(event.target.value)}>
            <option value="all">All topics</option>
            {topics.map(tag => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </div>
      </div>
      <section aria-labelledby="archive-heading">
        <div className="archive-heading">
          <h2 id="archive-heading">{hasFilters ? "Your reading list" : "All writing"}</h2>
          <p role="status" className="results-count">{filtered.length} {filtered.length === 1 ? "article" : "articles"}{topic !== "all" ? ` in ${topic}` : ""}</p>
          {hasFilters && filtered.length > 0 && <button className="clear-filter-link" type="button" onClick={clearFilters}>Clear filters</button>}
        </div>
        <div className="article-grid archive-grid">{filtered.map(article => <ArticleCard key={article.id} article={article} />)}</div>
        {!filtered.length && <div className="empty-state"><h2>No articles found.</h2><p>Try another topic or search term.</p><button className="primary-link" type="button" onClick={clearFilters}>Clear filters</button></div>}
      </section>
    </div>
  );
}

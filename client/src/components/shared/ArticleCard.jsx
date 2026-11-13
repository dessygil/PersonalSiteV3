import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatDate } from "../../lib/writing";

export default function ArticleCard({ article }) {
  const [imageError, setImageError] = useState(false);
  useEffect(() => setImageError(false), [article.coverImage]);
  const destination = `/writing/${article.slug}`;
  const titleId = `article-title-${article.id}`;

  return (
    <article className="article-card" aria-labelledby={titleId}>
      {article.coverImage && !imageError ? (
        <Link tabIndex={-1} aria-hidden="true" to={destination} className="article-card-image">
          <img src={article.coverImage} alt="" loading="lazy" decoding="async" onError={() => setImageError(true)} />
        </Link>
      ) : (
        <div className="article-card-image article-cover-placeholder" aria-hidden="true">
          <span className="placeholder-kicker">FROM THE NOTEBOOK</span>
          <span className="placeholder-topic">{article.tags[0] || "Field notes"}</span>
          <span className="placeholder-monogram">dg.</span>
        </div>
      )}
      <div className="article-card-content">
        <p className="article-meta card-meta">
          <time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>
          <span>{article.readingTimeMinutes} min read</span>
        </p>
        <h3 id={titleId}><Link to={destination}>{article.title}</Link></h3>
        <p className="article-excerpt">{article.description}</p>
        <div className="article-tags">{article.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div>
        <Link className="article-read-link" to={destination} aria-label={`Read ${article.title}`}>
          Read article <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </article>
  );
}

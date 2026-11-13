import React from "react";
import { Link } from "react-router-dom";
import defaultArticles from "../../lib/writingData";
import ArticleCard from "../shared/ArticleCard";
export default function BlogIntro({ articles = defaultArticles }) {
  return <section id="Blog-anchor" className="content-section" aria-labelledby="writing-heading"><div className="section-heading"><div><span className="section-index">04 / WRITING</span><h2 id="writing-heading">Notes along the way.</h2></div><Link className="text-link" to="/writing">All {articles.length} articles →</Link></div><p className="section-summary">Science, software, and things worth figuring out. Full articles, right here.</p><div className="article-grid">{articles.slice(0, 3).map(article => <ArticleCard key={article.id} article={article} />)}</div></section>;
}

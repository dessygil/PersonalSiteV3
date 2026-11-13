import { findWritingTopic } from "./writingTopics";

export const SITE_NAME = "Desmond Gilmour";
export const SITE_DESCRIPTION = "Account Executive at Nicoya. Chemistry, computer science, and commercial strategy. Experience, projects, and writing by Desmond Gilmour.";
export const WRITING_DESCRIPTION = "Articles by Desmond Gilmour on biophysical science, chemistry, and building software.";
export const PERSONAL_SITE_ORIGIN = "https://desmondgilmour.com";

export function articleCanonical(article, origin) {
  // Only the real site serving this route can declare its article the primary
  // version. Private previews keep the working DEV.to source URL.
  return new URL(origin).origin === PERSONAL_SITE_ORIGIN
    ? new URL(`/writing/${article.slug}`, PERSONAL_SITE_ORIGIN).href
    : article.sourceUrl || article.canonicalUrl;
}

export function personMetadata(origin) {
  const home = new URL("/", origin).href;
  return {
    "@type": "Person", "@id": `${home}#person`, name: SITE_NAME, url: home,
    image: new URL("/media/desmond-gilmour-640.webp", origin).href,
    description: "Account Executive at Nicoya with a background in chemistry, computer science, and commercial strategy.",
    jobTitle: "Account Executive",
    worksFor: { "@type": "Organization", name: "Nicoya", url: "https://nicoyalife.com/" },
    alumniOf: { "@type": "CollegeOrUniversity", name: "University of Guelph", url: "https://www.uoguelph.ca/" },
    hasCredential: [
      { "@type": "EducationalOccupationalCredential", name: "B.Sc. — Physical Sciences, Chemistry minor", credentialCategory: "degree" },
      { "@type": "EducationalOccupationalCredential", name: "B.Comp. — Computer Science, General degree", credentialCategory: "degree" },
    ],
    knowsAbout: ["Scientific instrumentation", "Protein characterization", "Chemistry", "Computer science", "Sales strategy"],
    sameAs: ["https://www.linkedin.com/in/desmondgilmour", "https://github.com/dessygil", "https://dev.to/dessygil"],
  };
}

export function createPageMetadata({ articles = [], path = "/", origin }) {
  const normalizedPath = path.replace(/\/+$/, "") || "/";
  const article = articles.find(item => normalizedPath === `/writing/${item.slug}`);
  const topic = normalizedPath.startsWith("/writing/topics/") ? findWritingTopic(articles, normalizedPath.slice("/writing/topics/".length)) : undefined;
  const home = new URL("/", origin).href;
  const url = new URL(normalizedPath, home).href;
  const person = personMetadata(home);
  const noindex = !["/", "/writing"].includes(normalizedPath) && !article && !topic;
  const dashboard = normalizedPath === "/dashboard/writing";
  const title = dashboard ? `Private writing dashboard | ${SITE_NAME}` : article ? `${article.title} | ${SITE_NAME}`
    : topic ? `${topic.title} | Writing | ${SITE_NAME}`
    : normalizedPath === "/writing" ? `Writing | ${SITE_NAME}`
      : noindex ? `Page not found | ${SITE_NAME}` : `${SITE_NAME} | Experience, projects & writing`;
  const description = dashboard ? "Private writing statistics for the site owner." : article ? article.description || WRITING_DESCRIPTION
    : topic ? `${topic.articles.length} ${topic.articles.length === 1 ? "article" : "articles"} by ${SITE_NAME} about ${topic.title}.`
    : normalizedPath === "/writing" ? WRITING_DESCRIPTION
      : noindex ? "This page could not be found. Explore Desmond Gilmour’s experience, projects, and writing." : SITE_DESCRIPTION;
  const image = new URL(article?.coverImage || "/writing-social.png", home).href;
  const imageAlt = article?.title || "Desmond Gilmour — experience, projects, and writing";
  const canonical = article ? articleCanonical(article, origin) : url;
  let pageSchema;
  if (article) {
    pageSchema = {
      "@type": "BlogPosting", "@id": `${url}#article`, headline: article.title,
      description, datePublished: article.publishedAt, dateModified: article.updatedAt || article.publishedAt,
      author: person, image, url, mainEntityOfPage: canonical, keywords: article.tags.join(", "),
      isPartOf: { "@type": "Blog", "@id": `${home}writing#blog`, url: `${home}writing`, name: `Writing | ${SITE_NAME}` },
    };
  } else if (topic) {
    pageSchema = {
      "@type": "CollectionPage", "@id": `${url}#collection`, name: title, description, url,
      author: person, about: { "@type": "Thing", name: topic.title },
      isPartOf: { "@type": "Blog", "@id": `${home}writing#blog`, url: `${home}writing` },
      mainEntity: { "@type": "ItemList", itemListElement: topic.articles.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.title, url: new URL(`/writing/${item.slug}`, home).href })) },
    };
  } else if (normalizedPath === "/writing") {
    pageSchema = {
      "@type": "Blog", "@id": `${url}#blog`, name: title, description, url,
      author: person, mainEntityOfPage: url,
      blogPost: articles.map(item => ({ "@type": "BlogPosting", "@id": new URL(`/writing/${item.slug}#article`, home).href, headline: item.title, url: new URL(`/writing/${item.slug}`, home).href })),
    };
  } else if (noindex) {
    pageSchema = { "@type": "WebPage", name: title, description, url };
  } else {
    pageSchema = { "@type": "ProfilePage", "@id": `${home}#profile`, name: title, description, url, mainEntity: person };
  }
  const social = {
    "og:type": article ? "article" : "website", "og:site_name": SITE_NAME,
    "og:title": title, "og:description": description, "og:url": url,
    "og:image": image, "og:image:alt": imageAlt,
    "twitter:card": "summary_large_image", "twitter:title": title,
    "twitter:description": description, "twitter:image": image, "twitter:image:alt": imageAlt,
  };
  const articleMeta = article ? {
    "article:published_time": article.publishedAt,
    "article:modified_time": article.updatedAt || article.publishedAt,
    "article:author": home,
  } : {};
  return { title, description, canonical, url, image, imageAlt, social, articleMeta, schema: { "@context": "https://schema.org", ...pageSchema }, noindex, feedUrl: new URL("/feed.xml", home).href };
}

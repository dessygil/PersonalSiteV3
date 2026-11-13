const topicTitles = {
  ai: "AI", cpp: "C++", rdkit: "RDKit", datamol: "Datamol", graphql: "GraphQL",
  nextjs: "Next.js", threej: "Three.js", ui: "UI", chatgpt: "ChatGPT", overleaf: "Overleaf",
  machinelearning: "Machine learning", softwaredevelopment: "Software development", web3: "Web3"
};

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase();
}

export function topicSlug(tag) {
  const normalized = normalizeTag(tag);
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) return normalized;
  return `tag--${Array.from(normalized).map(character => character.codePointAt(0).toString(16)).join("-")}`;
}

export function getWritingTopics(articles) {
  const topics = new Map();
  for (const article of articles) {
    for (const tag of new Set((article.tags || []).map(normalizeTag).filter(Boolean))) {
      if (!topics.has(tag)) {
        topics.set(tag, {
          slug: topicSlug(tag), tag,
          title: topicTitles[tag] || tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " "),
          articles: []
        });
      }
      topics.get(tag).articles.push(article);
    }
  }
  return [...topics.values()].sort((a, b) => b.articles.length - a.articles.length || a.tag.localeCompare(b.tag, "en"));
}

export function findWritingTopic(articles, slug) {
  return getWritingTopics(articles).find(topic => topic.slug === slug);
}

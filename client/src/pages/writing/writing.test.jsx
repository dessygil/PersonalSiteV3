import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, cleanup, within, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import "@testing-library/jest-dom";
import Writing from "./Writing";
import Article, { prepareArticleContent, sanitizeArticle } from "./Article";
import Topic from "./Topic";
import { getWritingTopics, topicSlug } from "../../lib/writingTopics";
import TopBar from "../../components/topbar/TopBar";
import articles from "../../data/articles.json";

const originalFetch = global.fetch;
beforeAll(() => {
  window.scrollTo = jest.fn(); Element.prototype.scrollIntoView = jest.fn();
  global.fetch = jest.fn(async url => {
    const article = articles.find(item => url === `/api/articles/${item.slug}`);
    return { ok: !!article, json: async () => article };
  });
});
afterAll(() => { global.fetch = originalFetch; });

const routerOptions = { v7_startTransition: true, v7_relativeSplatPath: true };
function renderWriting(path = "/writing") {
  return render(<MemoryRouter initialEntries={[path]} future={routerOptions}><TopBar /><Routes><Route path="/writing" element={<Writing />} /><Route path="/writing/topics/:slug" element={<Topic />} /><Route path="/writing/:slug" element={<Article />} /></Routes></MemoryRouter>);
}

test("the complete archive links to local articles and supports search/reset", () => {
  renderWriting();
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(articles.length);
  for (const article of articles) {
    expect(screen.getByRole("link", { name: article.title })).toHaveAttribute("href", `/writing/${article.slug}`);
  }
  fireEvent.change(screen.getByLabelText("Search the archive"), { target: { value: "no-such-article-xyz" } });
  expect(screen.getByRole("heading", { name: "No articles found." })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(articles.length);
  fireEvent.change(screen.getByLabelText("Search the archive"), { target: { value: articles[0].title } });
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
});

test("topic selection narrows the archive to the chosen topic", () => {
  renderWriting();
  const topic = articles[0].tags[0];
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: topic } });
  for (const article of articles) {
    const link = screen.queryByRole("link", { name: article.title });
    if (article.tags.includes(topic)) expect(link).toBeInTheDocument();
    else expect(link).not.toBeInTheDocument();
  }
});

test("topic collection routes keep search within their topic and provide a reset", () => {
  renderWriting("/writing/topics/python");
  expect(screen.getByRole("heading", { level: 1, name: "Python" })).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(articles.filter(article => article.tags.includes("python")).length);
  fireEvent.change(screen.getByLabelText("Search Python articles"), { target: { value: "does-not-exist" } });
  expect(screen.getByRole("heading", { name: "No articles found." })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("link", { name: "Contributing to RDKit" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: articles[0].title })).not.toBeInTheDocument();
});

test("future topic tags keep distinct stable URLs and avoid duplicate articles", () => {
  const sample = [{ id: 1, tags: ["C++", "c++", "c", "tag--63-2b-2b"] }];
  const topics = getWritingTopics(sample);
  expect(topics).toHaveLength(3);
  expect(new Set(topics.map(topic => topic.slug)).size).toBe(3);
  expect(topics.find(topic => topic.tag === "c++").articles).toHaveLength(1);
  expect(topicSlug(" Python ")).toBe("python");
});

test("unknown topic routes offer a route back to writing", () => {
  renderWriting("/writing/topics/does-not-exist");
  expect(screen.getByRole("heading", { name: "Topic not found." })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to all writing" })).toHaveAttribute("href", "/writing");
});

test("a failed article request falls back to the saved text", async () => {
  global.fetch.mockRejectedValueOnce(new Error("Offline"));
  const article = articles[0];
  const { container } = renderWriting(`/writing/${article.slug}`);
  await waitFor(() => expect(container.querySelector(".article-prose").textContent.length).toBeGreaterThan(200));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each(articles.map(article => [article.slug, article]))("direct article route renders full text: %s", async (_, article) => {
  const { container } = renderWriting(`/writing/${article.slug}`);
  expect(screen.getByRole("heading", { level: 1, name: article.title })).toBeInTheDocument();
  const original = new DOMParser().parseFromString(article.bodyHtml, "text/html");
  original.querySelectorAll(".highlight__panel").forEach(panel => panel.remove());
  const normalize = value => value.replace(/\s+/g, " ").trim();
  const finalParagraph = [...original.querySelectorAll("p")].reverse().find(p => normalize(p.textContent).length > 40);
  await waitFor(() => expect(normalize(container.querySelector(".article-prose").textContent)).toContain(normalize(finalParagraph.textContent)));
  expect(container.querySelector(".article-source a")).toHaveAttribute("href", article.sourceUrl);
  expect(container.querySelectorAll(".highlight__panel")).toHaveLength(0);
  cleanup();
});

test("imported HTML retains content while rejecting executable markup", () => {
  const html = sanitizeArticle('<h2>Useful heading</h2><table><tbody><tr><td>Data</td></tr></tbody></table><pre><code>const value = 1;</code></pre><script>alert(1)</script><img src="/writing-assets/test.png" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe</a><iframe src="https://example.com"></iframe><div class="highlight__panel">Dead control</div>');
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector("h2").textContent).toBe("Useful heading");
  expect(parsed.querySelector("td").textContent).toBe("Data");
  expect(parsed.querySelector("code").textContent).toBe("const value = 1;");
  expect(parsed.querySelector("script, iframe, [onerror], .highlight__panel")).toBeNull();
  expect(parsed.querySelector("a").hasAttribute("href")).toBe(false);
});

test("keyboard tab order reaches code and table scroll containers without trusting imported focus attributes", async () => {
  const source = '<p tabindex="9">Introduction</p><pre tabindex="-1" role="button" aria-label="Untrusted label" aria-labelledby="fake"><code tabindex="7">const value = 1;</code></pre><table tabindex="6" role="presentation" aria-label="Untrusted table"><caption>Measurements</caption><tbody><tr><td>Value</td></tr></tbody></table><a href="/writing">Continue</a>';
  const prepared = prepareArticleContent(source);
  const { container } = render(<div dangerouslySetInnerHTML={{ __html: prepared.html }} />);
  const block = screen.getByRole("region", { name: "Code block (scroll horizontally)" });
  const table = screen.getByRole("table", { name: "Measurements" });
  expect(block).toHaveAttribute("tabindex", "0");
  expect(block).not.toHaveAttribute("aria-labelledby");
  expect(table).toHaveAttribute("tabindex", "0");
  expect(container.querySelectorAll("[tabindex]")).toHaveLength(2);
  expect(container.querySelector("code").textContent).toBe("const value = 1;");
  const user = userEvent.setup();
  await user.tab();
  expect(block).toHaveFocus();
  await user.tab();
  expect(table).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("link", { name: "Continue" })).toHaveFocus();
  expect(prepareArticleContent(prepared.html).html).toBe(prepared.html);
});

test("heading anchors preserve legacy links and disambiguate repeated or reserved names", () => {
  const source = '<h1><a name="legacy" href="#legacy"></a>Introduction</h1><h2>Repeated heading</h2><h2>Repeated heading</h2><h2 id="repeated-heading">Existing anchor</h2><h2 id="article-heading">Page title collision</h2><h2>Résumé &amp; notes</h2>';
  const prepared = prepareArticleContent(source);
  render(<div dangerouslySetInnerHTML={{ __html: prepared.html }} />);
  expect(prepared.headings.map(heading => heading.id)).toEqual(["legacy", "repeated-heading-2", "repeated-heading-3", "repeated-heading", "article-heading-2", "resume-notes"]);
  expect(prepared.headings[0].level).toBe(2);
  for (const heading of prepared.headings) expect(screen.getAllByRole("heading", { name: heading.text }).map(element => element.getAttribute("id"))).toContain(heading.id);
  expect(prepareArticleContent(prepared.html).headings).toEqual(prepared.headings);
});

test("article contents links reach matching headings and move focus", async () => {
  renderWriting("/writing/lasso-highlighting-in-datamol-36l3");
  const contents = await screen.findByRole("navigation", { name: "On this page" });
  const links = within(contents).getAllByRole("link");
  for (const link of links) {
    const id = decodeURIComponent(link.getAttribute("href").split("#")[1]);
    expect(screen.getByRole("heading", { name: link.textContent })).toHaveAttribute("id", id);
  }
  fireEvent.click(links[0]);
  await waitFor(() => expect(screen.getByRole("heading", { name: links[0].textContent })).toHaveFocus());
  expect(screen.getByRole("link", { name: "datamol" })).toHaveAttribute("href", "/writing/topics/datamol");
});

test("unknown articles offer a route back to the archive", () => {
  renderWriting("/writing/does-not-exist");
  expect(screen.getByRole("heading", { name: "Article not found." })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to all writing →" })).toHaveAttribute("href", "/writing");
});

test("navigation has no resume download and exposes the mobile menu state", () => {
  renderWriting();
  const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
  expect(navigation.queryByRole("link", { name: /resume|résumé/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /resume|résumé/i })).not.toBeInTheDocument();
  const menu = screen.getByRole("button", { name: "Menu" });
  expect(menu).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(menu);
  expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute("aria-expanded", "true");
});

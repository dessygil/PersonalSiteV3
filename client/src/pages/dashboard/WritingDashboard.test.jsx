import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import WritingDashboard, { parseWritingStatsCsv } from "./WritingDashboard";

jest.mock("../../lib/usePageNavigation", () => jest.fn());
const originalFetch = global.fetch;
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const snapshot = () => ({
  articles: [
    { slug: "first-article", title: "First article", websiteViews: 12, likes: 3, devto: { views: 30, asOf: "2026-11-13T00:00:00.000Z", url: "https://dev.to/dessygil/first-article" }, substack: null, medium: null, totalViews: 42 },
    { slug: "second-article", title: "Second article", websiteViews: 0, likes: 0, devto: null, substack: { views: 0, asOf: "2026-11-13T00:00:00.000Z", url: "https://example.substack.com/p/second" }, medium: null, totalViews: 0 },
  ],
  totals: { websiteViews: 12, likes: 3, devtoViews: 30, substackViews: 0, mediumViews: null, reportedViews: 42 },
  daily: [{ day: "2026-11-12", views: 2 }, { day: "2026-11-13", views: 4 }],
  coverage: { websiteSince: "2026-11-01", generatedAt: "2026-11-13T18:00:00Z", lastUpdated: "2026-11-13T17:00:00Z", analyticsEnabled: true, platforms: { devto: { reportedArticles: 1, totalArticles: 2, earliestAsOf: "2026-11-13T00:00:00Z", latestAsOf: "2026-11-13T00:00:00Z" }, substack: { reportedArticles: 1, totalArticles: 2 }, medium: { reportedArticles: 0, totalArticles: 2 } } },
});
function mount() { return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><WritingDashboard /></MemoryRouter>); }
async function loaded() { await screen.findByRole("heading", { name: "Views across your writing" }); }
beforeEach(() => { global.fetch = jest.fn().mockResolvedValue(response(snapshot())); });
afterAll(() => { global.fetch = originalFetch; });
afterEach(() => { jest.useRealTimers(); });

test("anonymous readers only see the normal top-level ChatGPT sign-in flow", async () => {
  fetch.mockResolvedValue(response({ error: "Sign in" }, 401));
  mount();
  const signIn = await screen.findByRole("link", { name: "Sign in with ChatGPT" });
  expect(signIn).toHaveAttribute("href", "/signin-with-chatgpt?return_to=%2Fdashboard%2Fwriting");
  expect(signIn).toHaveAttribute("target", "_top");
  expect(screen.queryByText("First article")).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith("/api/private/writing-dashboard", expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }));
});

test("non-owners never receive statistics or import controls", async () => {
  fetch.mockResolvedValue(response({ error: "Owner only" }, 403));
  mount();
  expect(await screen.findByRole("heading", { name: "This dashboard is private." })).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

test("reported snapshots remain distinct from zero, website views, and unique readers", async () => {
  mount(); await loaded();
  const table = screen.getByRole("table", { name: /Recorded website views/ });
  const rows = within(table).getAllByRole("row");
  expect(within(rows[1]).getAllByText("Not added")).toHaveLength(2);
  expect(within(rows[2]).getAllByText("Not added")).toHaveLength(2);
  expect(within(rows[2]).getAllByText("0")).toHaveLength(4);
  expect(within(rows[1]).getByText(/As of Nov 13, 2026/)).toBeInTheDocument();
  expect(screen.queryByText(/As of Nov 12, 2026/)).not.toBeInTheDocument();
  expect(screen.getByText(/Views are not unique readers/)).toBeInTheDocument();
  expect(screen.getByText(/Incomplete coverage/)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /Daily website article views: 6 in total/ })).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "Website article views by day", hidden: true })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Find an article"), { target: { value: "Second" } });
  expect(within(table).queryByRole("link", { name: "First article" })).not.toBeInTheDocument();
  expect(within(table).getByRole("link", { name: "Second article" })).toHaveAttribute("href", "/writing/second-article");
});

test("a failed load offers retry and never substitutes fabricated zero statistics", async () => {
  fetch.mockRejectedValueOnce(new Error("Offline"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("dashboard could not be loaded");
  expect(screen.queryByText("Website article views")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await loaded();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("expired authentication removes already loaded private data", async () => {
  mount(); await loaded();
  fetch.mockResolvedValueOnce(response({ error: "Session expired" }, 401));
  fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
  await screen.findByRole("link", { name: "Sign in with ChatGPT" });
  expect(screen.queryByRole("link", { name: "First article" })).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

test("DEV.to key is sent only in the POST body, immediately cleared, and never stored", async () => {
  let finish;
  const storage = jest.spyOn(Storage.prototype, "setItem");
  mount(); await loaded();
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const input = screen.getByLabelText("DEV.to API key (if requested)");
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, { target: { value: "private-key-for-test" } });
  const form = screen.getByRole("form", { name: "Import DEV.to statistics" });
  fireEvent.submit(form); fireEvent.submit(form);
  expect(input).toHaveValue("");
  expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
  const calls = fetch.mock.calls.filter(([url]) => url === "/api/private/devto-stats");
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toEqual(expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ apiKey: "private-key-for-test" }) }));
  expect(storage).not.toHaveBeenCalled();
  await act(async () => finish(response({ ok: true, imported: 1, platform: "devto" })));
  expect(await screen.findByRole("status")).toHaveTextContent("Updated DEV.to views for 1 article");
  expect(input).toHaveValue("");
  storage.mockRestore();
});

test("missing DEV.to key asks for it without locking the owner out", async () => {
  mount(); await loaded();
  fetch.mockResolvedValueOnce(response({ error: "Key required", code: "devto_key_required" }, 409));
  fireEvent.submit(screen.getByRole("form", { name: "Import DEV.to statistics" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter an API key from your existing DEV.to account");
  expect(screen.getByLabelText("DEV.to API key (if requested)")).toHaveFocus();
  expect(screen.getByRole("heading", { name: "Views across your writing" })).toBeInTheDocument();
});

test.each([
  ["devto_invalid_key", 400, /API key is invalid or was not accepted by DEV.to/],
  ["devto_account_mismatch", 400, /key belongs to a different DEV.to account/],
  ["devto_connection_failed", 502, /Website could not connect to DEV.to\. This does not mean your API key is wrong/],
  ["devto_blocked", 502, /DEV.to blocked the request/],
  ["devto_rate_limited", 429, /DEV.to is limiting requests/],
  ["devto_unavailable", 502, /DEV.to returned an error/],
  ["devto_invalid_response", 502, /DEV.to returned data this website could not use/],
  ["devto_no_matching_articles", 400, /No DEV.to articles matched this website/],
  ["devto_import_conflict", 409, /newer snapshot is already saved/],
  ["devto_storage_unavailable", 503, /Statistics storage is unavailable/],
])("DEV.to failure %s shows its actual category without exposing upstream errors", async (code, status, expected) => {
  mount(); await loaded();
  const input = screen.getByLabelText("DEV.to API key (if requested)");
  fireEvent.change(input, { target: { value: "test-key-that-must-be-cleared" } });
  fetch.mockResolvedValueOnce(response({ error: "Raw upstream error must stay hidden", code }, status));
  fireEvent.submit(screen.getByRole("form", { name: "Import DEV.to statistics" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(expected);
  expect(alert).not.toHaveTextContent("Raw upstream error");
  expect(alert).not.toHaveTextContent("Check your API key and try again");
  expect(input).toHaveValue("");
  expect(screen.getByRole("heading", { name: "Views across your writing" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "This dashboard is private." })).not.toBeInTheDocument();
});

test.each([
  [401, "Sign in to view your dashboard."],
  [403, "This dashboard is private."],
])("site authentication failure %s during import still clears private content", async (status, heading) => {
  mount(); await loaded();
  fetch.mockResolvedValueOnce(response({ error: "Website access denied" }, status));
  fireEvent.submit(screen.getByRole("form", { name: "Import DEV.to statistics" }));
  expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

test.each(["unexpected_error", "constructor", "__proto__"])("unknown import code %s remains unconfirmed and never repeats arbitrary server text", async code => {
  mount(); await loaded();
  fetch.mockResolvedValueOnce(response({ error: "Your key is definitely wrong: private-value", code }, 502));
  fireEvent.submit(screen.getByRole("form", { name: "Import DEV.to statistics" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The DEV.to import could not be confirmed");
  expect(alert).not.toHaveTextContent("key is definitely wrong");
  expect(alert).not.toHaveTextContent("private-value");
});

test("a browser network failure is distinguished from a rejected DEV.to API key", async () => {
  mount(); await loaded();
  fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fireEvent.submit(screen.getByRole("form", { name: "Import DEV.to statistics" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("import request could not reach the website");
  expect(screen.getByRole("alert")).not.toHaveTextContent("API key is invalid");
});

test("a timed-out import advises checking the dashboard before retrying", async () => {
  mount(); await loaded();
  jest.useFakeTimers();
  fetch.mockImplementationOnce((_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
  }));
  fireEvent.change(screen.getByLabelText("DEV.to API key (if requested)"), { target: { value: "test-key" } });
  fireEvent.submit(screen.getByRole("form", { name: "Import DEV.to statistics" }));
  await act(async () => jest.advanceTimersByTime(40000));
  expect(screen.getByRole("alert")).toHaveTextContent("import request timed out, so completion could not be confirmed");
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh the dashboard to check for an update");
  expect(screen.getByLabelText("DEV.to API key (if requested)")).toHaveValue("");
});

test("key instructions link directly to DEV.to settings and distinguish value from label", async () => {
  mount(); await loaded();
  expect(screen.getByRole("link", { name: "DEV.to API key settings ↗" })).toHaveAttribute("href", "https://dev.to/settings/extensions");
  expect(screen.getByText(/Copy the generated key value, not its label, and paste it here/)).toHaveTextContent("dessygil");
});

test("manual cumulative snapshots send the selected article, platform, and date exactly once", async () => {
  mount(); await loaded();
  const form = screen.getByRole("form", { name: "Save platform view counts" });
  fireEvent.submit(form);
  expect(await screen.findByRole("alert")).toHaveTextContent("Choose the date");
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Counts as of"), { target: { value: "2026-11-13" } });
  fireEvent.change(screen.getByLabelText("Article"), { target: { value: "first-article" } });
  fireEvent.change(screen.getByLabelText("Article URL on Substack"), { target: { value: "https://example.substack.com/p/first" } });
  fireEvent.change(screen.getByLabelText("Cumulative views"), { target: { value: "120" } });
  fetch.mockResolvedValueOnce(response({ ok: true, platform: "substack", imported: 1 }));
  fireEvent.submit(form);
  expect(await screen.findByRole("status")).toHaveTextContent("Existing snapshots were replaced, not added together");
  const [, request] = fetch.mock.calls.find(([url]) => url === "/api/private/writing-stats");
  expect(JSON.parse(request.body)).toEqual({ platform: "substack", asOf: "2026-11-13", articles: [{ slug: "first-article", url: "https://example.substack.com/p/first", views: 120 }] });
});

test("CSV import validates known slugs before sending one batch with the shared date", async () => {
  mount(); await loaded();
  fireEvent.change(screen.getByLabelText("Counts as of"), { target: { value: "2026-11-13" } });
  fireEvent.change(screen.getByLabelText("Entry method"), { target: { value: "csv" } });
  const file = new File([""], "stats.csv", { type: "text/csv" });
  file.text = async () => "slug,url,views\nunknown,https://example.substack.com/p/first,9";
  fireEvent.change(screen.getByLabelText("Statistics CSV"), { target: { files: [file] } });
  fireEvent.submit(screen.getByRole("form", { name: "Save platform view counts" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Every row must use a slug");
  expect(fetch).toHaveBeenCalledTimes(1);
  file.text = async () => "slug,url,views\nfirst-article,https://example.substack.com/p/first,9\nsecond-article,https://example.substack.com/p/second,0";
  fetch.mockResolvedValueOnce(response({ ok: true, imported: 2, platform: "substack" }));
  fireEvent.submit(screen.getByRole("form", { name: "Save platform view counts" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved Substack views for 2 articles"));
  const [, request] = fetch.mock.calls.find(([url]) => url === "/api/private/writing-stats");
  expect(JSON.parse(request.body).articles).toHaveLength(2);
  expect(JSON.parse(request.body).asOf).toBe("2026-11-13");
});

test("CSV handles BOM, alternate column order, quoted commas, and CRLF", () => {
  expect(parseWritingStatsCsv('\uFEFFviews,url,slug\r\n12,"https://example.substack.com/p/item?tag=a,b",first-article\r\n0,https://example.substack.com/p/two,second-article\r\n')).toEqual([
    { slug: "first-article", url: "https://example.substack.com/p/item?tag=a,b", views: 12 },
    { slug: "second-article", url: "https://example.substack.com/p/two", views: 0 },
  ]);
});

test.each([
  ["slug,url,views\na,https://example.substack.com/p/a,-1", /whole number/],
  ["slug,url,views\na,https://example.substack.com/p/a,1.2", /whole number/],
  ["slug,url,views\na,https://example.substack.com/p/a,9007199254740992", /whole number/],
  ["slug,url,views\na,http://example.substack.com/p/a,1", /HTTPS/],
  ["slug,url,views\na,https://user:pass@example.substack.com/p/a,1", /HTTPS/],
  ["slug,url,views\na,https://example.substack.com/p/a,1\na,https://example.substack.com/p/a,2", /distinct/],
  ['slug,url,views\na,"https://example.substack.com/p/a,1', /unfinished/],
  ['slug,url,views\na,"https://example.substack.com/p/a"junk,1', /quoted CSV field/],
  ["slug,url,wrong\na,https://example.substack.com/p/a,1", /header/],
  ["slug,url,views\n", /at least one/],
])("CSV rejects malformed statistics: %s", (input, error) => expect(() => parseWritingStatsCsv(input)).toThrow(error));
